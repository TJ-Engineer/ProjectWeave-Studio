use std::{sync::Arc, time::Duration};

use axum::{
    extract::{FromRequestParts, State},
    http::{header::AUTHORIZATION, request::Parts},
};
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header, jwk::JwkSet};
use serde::Deserialize;
use uuid::Uuid;

use crate::{
    AppState,
    config::{AuthMode, Config},
    error::ApiError,
    policy::Principal,
};

const ORGANIZATION_HEADER: &str = "x-openrm-organization";

#[derive(Clone)]
pub enum AuthVerifier {
    Dev,
    Oidc(Arc<OidcVerifier>),
}

#[derive(Debug, Deserialize)]
struct DiscoveryDocument {
    issuer: String,
    jwks_uri: String,
}

#[derive(Debug, Deserialize)]
struct Claims {
    sub: String,
    #[allow(dead_code)]
    exp: u64,
    #[serde(default, alias = "organization_id", alias = "custom:org_id")]
    org_id: Option<Uuid>,
    #[serde(default)]
    organization_ids: Vec<Uuid>,
    #[serde(default, alias = "cognito:groups")]
    roles: Vec<String>,
}

pub struct OidcVerifier {
    issuer: String,
    audience: String,
    keys: JwkSet,
}

#[derive(Clone, Debug)]
pub struct AuthenticatedPrincipal(pub Principal);

impl AuthVerifier {
    pub async fn from_config(config: &Config) -> Result<Self, ApiError> {
        match config.auth_mode {
            AuthMode::Dev => Ok(Self::Dev),
            AuthMode::Oidc => {
                let issuer = config
                    .oidc_issuer
                    .as_deref()
                    .ok_or_else(|| ApiError::unavailable("OIDC issuer is not configured"))?;
                let audience = config
                    .oidc_audience
                    .as_deref()
                    .ok_or_else(|| ApiError::unavailable("OIDC audience is not configured"))?;
                Ok(Self::Oidc(Arc::new(
                    OidcVerifier::discover(issuer, audience).await?,
                )))
            }
        }
    }

    pub fn dev() -> Self {
        Self::Dev
    }

    fn verify(&self, token: &str, organization_id: Uuid) -> Result<Principal, ApiError> {
        match self {
            Self::Dev => verify_dev_token(token, organization_id),
            Self::Oidc(verifier) => verifier.verify(token, organization_id),
        }
    }
}

impl OidcVerifier {
    async fn discover(issuer: &str, audience: &str) -> Result<Self, ApiError> {
        let issuer = issuer.trim_end_matches('/');
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|error| {
                ApiError::unavailable(format!("OIDC client configuration failed: {error}"))
            })?;
        let discovery: DiscoveryDocument = client
            .get(format!("{issuer}/.well-known/openid-configuration"))
            .send()
            .await
            .map_err(|error| ApiError::unavailable(format!("OIDC discovery failed: {error}")))?
            .error_for_status()
            .map_err(|error| ApiError::unavailable(format!("OIDC discovery failed: {error}")))?
            .json()
            .await
            .map_err(|error| {
                ApiError::unavailable(format!("OIDC discovery response was invalid: {error}"))
            })?;

        if discovery.issuer.trim_end_matches('/') != issuer {
            return Err(ApiError::unavailable(
                "OIDC discovery issuer does not match configuration",
            ));
        }
        let jwks_url = reqwest::Url::parse(&discovery.jwks_uri)
            .map_err(|_| ApiError::unavailable("OIDC discovery returned an invalid JWKS URL"))?;
        if jwks_url.scheme() != "https"
            || jwks_url.host_str().is_none()
            || !jwks_url.username().is_empty()
            || jwks_url.password().is_some()
            || jwks_url.query().is_some()
            || jwks_url.fragment().is_some()
        {
            return Err(ApiError::unavailable(
                "OIDC JWKS URL must use HTTPS without credentials, query, or fragment",
            ));
        }

        let keys: JwkSet = client
            .get(jwks_url)
            .send()
            .await
            .map_err(|error| ApiError::unavailable(format!("OIDC JWKS request failed: {error}")))?
            .error_for_status()
            .map_err(|error| ApiError::unavailable(format!("OIDC JWKS request failed: {error}")))?
            .json()
            .await
            .map_err(|error| {
                ApiError::unavailable(format!("OIDC JWKS response was invalid: {error}"))
            })?;

        if keys.keys.is_empty() {
            return Err(ApiError::unavailable(
                "OIDC provider returned no signing keys",
            ));
        }

        Ok(Self {
            issuer: issuer.to_owned(),
            audience: audience.to_owned(),
            keys,
        })
    }

    fn verify(&self, token: &str, organization_id: Uuid) -> Result<Principal, ApiError> {
        let header = decode_header(token)
            .map_err(|_| ApiError::unauthorized("Bearer token is malformed"))?;
        if !matches!(
            header.alg,
            Algorithm::RS256 | Algorithm::RS384 | Algorithm::RS512
        ) {
            return Err(ApiError::unauthorized(
                "Bearer token uses an unsupported signing algorithm",
            ));
        }
        let kid = header
            .kid
            .as_deref()
            .ok_or_else(|| ApiError::unauthorized("Bearer token does not declare a signing key"))?;
        let jwk = self
            .keys
            .find(kid)
            .ok_or_else(|| ApiError::unauthorized("Bearer token signing key is unknown"))?;
        let key = DecodingKey::from_jwk(jwk)
            .map_err(|_| ApiError::unauthorized("Bearer token signing key is invalid"))?;
        let mut validation = Validation::new(header.alg);
        validation.set_audience(&[self.audience.as_str()]);
        validation.set_issuer(&[self.issuer.as_str()]);
        validation.set_required_spec_claims(&["exp", "iss", "aud", "sub"]);
        let claims = decode::<Claims>(token, &key, &validation)
            .map_err(|_| ApiError::unauthorized("Bearer token validation failed"))?
            .claims;

        let organization_allowed = claims.org_id == Some(organization_id)
            || claims.organization_ids.contains(&organization_id);
        if !organization_allowed {
            return Err(ApiError::forbidden(
                "Token is not authorized for this organization",
            ));
        }

        Ok(Principal {
            subject: claims.sub,
            organization_id,
            roles: claims.roles,
        })
    }
}

impl FromRequestParts<AppState> for AuthenticatedPrincipal {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let token = parts
            .headers
            .get(AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .filter(|value| !value.is_empty())
            .ok_or_else(|| ApiError::unauthorized("A Bearer token is required"))?;
        let organization_id = parts
            .headers
            .get(ORGANIZATION_HEADER)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| ApiError::forbidden("X-OpenRM-Organization is required"))?
            .parse::<Uuid>()
            .map_err(|_| ApiError::forbidden("X-OpenRM-Organization must be a UUID"))?;

        Ok(Self(state.auth.verify(token, organization_id)?))
    }
}

pub async fn session_principal(
    State(_state): State<AppState>,
    AuthenticatedPrincipal(principal): AuthenticatedPrincipal,
) -> Principal {
    principal
}

fn verify_dev_token(token: &str, organization_id: Uuid) -> Result<Principal, ApiError> {
    let value = token
        .strip_prefix("dev:")
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| ApiError::unauthorized("Development token must use dev:<subject>"))?;
    let (subject, role) = value
        .rsplit_once(':')
        .filter(|(_, role)| matches!(*role, "administrator" | "author" | "reviewer" | "viewer"))
        .unwrap_or((value, "administrator"));
    if subject.trim().is_empty() {
        return Err(ApiError::unauthorized(
            "Development token subject must not be empty",
        ));
    }

    Ok(Principal {
        subject: subject.to_owned(),
        organization_id,
        roles: vec![role.to_owned()],
    })
}

#[cfg(test)]
mod tests {
    use super::{AuthVerifier, verify_dev_token};
    use uuid::Uuid;

    #[test]
    fn development_token_is_explicit_and_scoped() {
        let organization_id = Uuid::new_v4();
        let principal =
            verify_dev_token("dev:ci-user", organization_id).expect("token should verify");
        assert_eq!(principal.subject, "ci-user");
        assert_eq!(principal.organization_id, organization_id);
    }

    #[test]
    fn rejects_non_development_tokens_in_dev_mode() {
        let result = AuthVerifier::dev().verify("opaque", Uuid::new_v4());
        assert!(result.is_err());
    }

    #[test]
    fn development_token_can_select_a_project_role() {
        let principal = verify_dev_token("dev:author-user:author", Uuid::new_v4())
            .expect("role-scoped token should verify");
        assert_eq!(principal.subject, "author-user");
        assert_eq!(principal.roles, vec!["author"]);
    }
}
