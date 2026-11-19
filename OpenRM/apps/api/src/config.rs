use std::{env, net::SocketAddr, str::FromStr};

use thiserror::Error;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AuthMode {
    Dev,
    Oidc,
}

#[derive(Clone)]
pub struct Config {
    pub app_env: String,
    pub bind_address: SocketAddr,
    pub database_url: String,
    pub run_migrations: bool,
    pub auth_mode: AuthMode,
    pub oidc_issuer: Option<String>,
    pub oidc_audience: Option<String>,
    pub cognito_user_pool_id: Option<String>,
    pub evidence_signing_key: String,
    pub evidence_signing_key_id: String,
    pub evidence_verification_keys: Vec<(String, String)>,
    pub jira_api_token: Option<String>,
    pub object_storage_bucket: Option<String>,
    pub object_storage_region: String,
    pub object_storage_endpoint: Option<String>,
    pub object_storage_force_path_style: bool,
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("{0} is required")]
    Missing(&'static str),
    #[error("{name} has an invalid value: {message}")]
    Invalid { name: &'static str, message: String },
    #[error("AUTH_MODE=dev is forbidden when APP_ENV=production")]
    DevAuthInProduction,
}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        let app_env = env::var("APP_ENV").unwrap_or_else(|_| "development".to_owned());
        let bind_address = parse(
            "API_BIND_ADDRESS",
            env::var("API_BIND_ADDRESS").unwrap_or_else(|_| "127.0.0.1:8080".to_owned()),
        )?;
        let database_url = database_url()?;
        let run_migrations = parse(
            "RUN_MIGRATIONS",
            env::var("RUN_MIGRATIONS").unwrap_or_else(|_| "false".to_owned()),
        )?;
        let auth_mode = match env::var("AUTH_MODE")
            .unwrap_or_else(|_| "oidc".to_owned())
            .to_ascii_lowercase()
            .as_str()
        {
            "dev" => AuthMode::Dev,
            "oidc" => AuthMode::Oidc,
            value => {
                return Err(ConfigError::Invalid {
                    name: "AUTH_MODE",
                    message: format!("expected dev or oidc, got {value}"),
                });
            }
        };

        if app_env.eq_ignore_ascii_case("production") && auth_mode == AuthMode::Dev {
            return Err(ConfigError::DevAuthInProduction);
        }

        let (oidc_issuer, oidc_audience, cognito_user_pool_id) = match auth_mode {
            AuthMode::Dev => (None, None, None),
            AuthMode::Oidc => (
                Some(required("OIDC_ISSUER")?),
                Some(required("OIDC_AUDIENCE")?),
                Some(required("COGNITO_USER_POOL_ID")?),
            ),
        };
        if app_env.eq_ignore_ascii_case("production")
            && !oidc_issuer.as_deref().is_some_and(valid_https_issuer)
        {
            return Err(ConfigError::Invalid {
                name: "OIDC_ISSUER",
                message:
                    "production issuer must be an HTTPS URL without credentials, query, or fragment"
                        .to_owned(),
            });
        }
        let evidence_signing_key = match env::var("EVIDENCE_SIGNING_KEY") {
            Ok(value) if app_env.eq_ignore_ascii_case("production") && value.len() < 32 => {
                return Err(ConfigError::Invalid {
                    name: "EVIDENCE_SIGNING_KEY",
                    message: "production key must contain at least 32 bytes".to_owned(),
                });
            }
            Ok(value) if !value.trim().is_empty() => value,
            _ if app_env.eq_ignore_ascii_case("production") => {
                return Err(ConfigError::Missing("EVIDENCE_SIGNING_KEY"));
            }
            _ => "openrm-development-evidence-key".to_owned(),
        };
        let evidence_signing_key_id = match env::var("EVIDENCE_SIGNING_KEY_ID") {
            Ok(value) if !value.trim().is_empty() => value,
            _ if app_env.eq_ignore_ascii_case("production") => {
                return Err(ConfigError::Missing("EVIDENCE_SIGNING_KEY_ID"));
            }
            _ => "development".to_owned(),
        };
        let evidence_verification_keys = match env::var("EVIDENCE_VERIFICATION_KEYS") {
            Ok(value) if !value.trim().is_empty() => {
                parse_verification_keys(&value, app_env.eq_ignore_ascii_case("production"))?
            }
            _ => Vec::new(),
        };
        if evidence_verification_keys
            .iter()
            .any(|(key_id, _)| key_id == &evidence_signing_key_id)
        {
            return Err(ConfigError::Invalid {
                name: "EVIDENCE_VERIFICATION_KEYS",
                message: "historical key identifiers must differ from EVIDENCE_SIGNING_KEY_ID"
                    .to_owned(),
            });
        }
        let jira_api_token = env::var("JIRA_API_TOKEN")
            .ok()
            .filter(|value| !value.trim().is_empty());
        let object_storage_bucket = env::var("OBJECT_STORAGE_BUCKET")
            .ok()
            .filter(|value| !value.trim().is_empty());
        if object_storage_bucket
            .as_deref()
            .is_some_and(|value| !valid_bucket_name(value))
        {
            return Err(ConfigError::Invalid {
                name: "OBJECT_STORAGE_BUCKET",
                message: "expected a valid DNS-compatible bucket name".to_owned(),
            });
        }
        let object_storage_region = env::var("OBJECT_STORAGE_REGION")
            .or_else(|_| env::var("AWS_REGION"))
            .unwrap_or_else(|_| "us-east-2".to_owned());
        let object_storage_endpoint = env::var("OBJECT_STORAGE_ENDPOINT")
            .ok()
            .filter(|value| !value.trim().is_empty());
        if let Some(endpoint) = object_storage_endpoint.as_deref()
            && !valid_object_storage_endpoint(endpoint, app_env.eq_ignore_ascii_case("production"))
        {
            return Err(ConfigError::Invalid {
                name: "OBJECT_STORAGE_ENDPOINT",
                message: "expected an HTTP(S) origin without credentials, query, or fragment; production requires HTTPS".to_owned(),
            });
        }
        let object_storage_force_path_style = parse(
            "OBJECT_STORAGE_FORCE_PATH_STYLE",
            env::var("OBJECT_STORAGE_FORCE_PATH_STYLE")
                .unwrap_or_else(|_| object_storage_endpoint.is_some().to_string()),
        )?;

        Ok(Self {
            app_env,
            bind_address,
            database_url,
            run_migrations,
            auth_mode,
            oidc_issuer,
            oidc_audience,
            cognito_user_pool_id,
            evidence_signing_key,
            evidence_signing_key_id,
            evidence_verification_keys,
            jira_api_token,
            object_storage_bucket,
            object_storage_region,
            object_storage_endpoint,
            object_storage_force_path_style,
        })
    }
}

fn parse_verification_keys(
    value: &str,
    production: bool,
) -> Result<Vec<(String, String)>, ConfigError> {
    let keys = serde_json::from_str::<std::collections::BTreeMap<String, String>>(value).map_err(
        |error| ConfigError::Invalid {
            name: "EVIDENCE_VERIFICATION_KEYS",
            message: format!("expected a JSON object of key identifiers to keys: {error}"),
        },
    )?;
    if keys.iter().any(|(key_id, key)| {
        key_id.trim().is_empty() || key.trim().is_empty() || (production && key.len() < 32)
    }) {
        return Err(ConfigError::Invalid {
            name: "EVIDENCE_VERIFICATION_KEYS",
            message: "key identifiers and keys must be non-empty, and production keys must contain at least 32 bytes"
                .to_owned(),
        });
    }
    Ok(keys.into_iter().collect())
}

fn required(name: &'static str) -> Result<String, ConfigError> {
    env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .ok_or(ConfigError::Missing(name))
}

fn database_url() -> Result<String, ConfigError> {
    if let Some(value) = env::var("DATABASE_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
    {
        return Ok(value);
    }

    let host = required("DATABASE_HOST")?;
    let port = parse(
        "DATABASE_PORT",
        env::var("DATABASE_PORT").unwrap_or_else(|_| "5432".to_owned()),
    )?;
    let database = required("DATABASE_NAME")?;
    let username = required("DATABASE_USER")?;
    let password = required("DATABASE_PASSWORD")?;
    let ssl_mode = env::var("DATABASE_SSL_MODE").unwrap_or_else(|_| "require".to_owned());
    let ssl_root_cert = env::var("DATABASE_SSL_ROOT_CERT")
        .ok()
        .filter(|value| !value.trim().is_empty());
    database_url_from_parts(
        &host,
        port,
        &database,
        &username,
        &password,
        &ssl_mode,
        ssl_root_cert.as_deref(),
    )
}

fn database_url_from_parts(
    host: &str,
    port: u16,
    database: &str,
    username: &str,
    password: &str,
    ssl_mode: &str,
    ssl_root_cert: Option<&str>,
) -> Result<String, ConfigError> {
    if database.contains(['/', '?', '#']) {
        return Err(ConfigError::Invalid {
            name: "DATABASE_NAME",
            message: "must be a single PostgreSQL database identifier".to_owned(),
        });
    }
    if !matches!(ssl_mode, "require" | "verify-ca" | "verify-full") {
        return Err(ConfigError::Invalid {
            name: "DATABASE_SSL_MODE",
            message: "expected require, verify-ca, or verify-full".to_owned(),
        });
    }
    if ssl_root_cert.is_some_and(|path| !path.starts_with('/') || path.contains('\0')) {
        return Err(ConfigError::Invalid {
            name: "DATABASE_SSL_ROOT_CERT",
            message: "must be an absolute filesystem path".to_owned(),
        });
    }

    let mut url =
        reqwest::Url::parse("postgres://localhost").map_err(|error| ConfigError::Invalid {
            name: "DATABASE_HOST",
            message: error.to_string(),
        })?;
    url.set_host(Some(host)).map_err(|_| ConfigError::Invalid {
        name: "DATABASE_HOST",
        message: "must be a valid hostname or IP address".to_owned(),
    })?;
    url.set_port(Some(port)).map_err(|_| ConfigError::Invalid {
        name: "DATABASE_PORT",
        message: "must be a valid TCP port".to_owned(),
    })?;
    url.set_username(username)
        .map_err(|_| ConfigError::Invalid {
            name: "DATABASE_USER",
            message: "could not be encoded safely".to_owned(),
        })?;
    url.set_password(Some(password))
        .map_err(|_| ConfigError::Invalid {
            name: "DATABASE_PASSWORD",
            message: "could not be encoded safely".to_owned(),
        })?;
    url.set_path(database);
    url.query_pairs_mut().append_pair("sslmode", ssl_mode);
    if let Some(path) = ssl_root_cert {
        url.query_pairs_mut().append_pair("sslrootcert", path);
    }
    Ok(url.into())
}

fn parse<T>(name: &'static str, value: String) -> Result<T, ConfigError>
where
    T: FromStr,
    T::Err: std::fmt::Display,
{
    value.parse().map_err(|error: T::Err| ConfigError::Invalid {
        name,
        message: error.to_string(),
    })
}

fn valid_https_issuer(value: &str) -> bool {
    reqwest::Url::parse(value).is_ok_and(|url| {
        url.scheme() == "https"
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
    })
}

fn valid_bucket_name(value: &str) -> bool {
    (3..=63).contains(&value.len())
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'-')
        })
        && value
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && value
            .bytes()
            .last()
            .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && !value.contains("..")
        && !value.contains(".-")
        && !value.contains("-.")
}

fn valid_object_storage_endpoint(value: &str, production: bool) -> bool {
    reqwest::Url::parse(value).is_ok_and(|url| {
        matches!(url.scheme(), "http" | "https")
            && (!production || url.scheme() == "https")
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
    })
}

#[cfg(test)]
mod tests {
    use super::{
        AuthMode, database_url_from_parts, parse_verification_keys, valid_bucket_name,
        valid_https_issuer, valid_object_storage_endpoint,
    };

    #[test]
    fn validates_object_storage_boundaries() {
        assert!(valid_bucket_name("openrm-controlled-objects"));
        assert!(!valid_bucket_name("OpenRM Objects"));
        assert!(valid_object_storage_endpoint("http://minio:9000", false));
        assert!(valid_object_storage_endpoint(
            "https://objects.example.com",
            true
        ));
        assert!(!valid_object_storage_endpoint(
            "http://objects.example.com",
            true
        ));
    }

    #[test]
    fn auth_mode_values_are_distinct() {
        assert_ne!(AuthMode::Dev, AuthMode::Oidc);
    }

    #[test]
    fn parses_historical_evidence_keys() {
        let keys =
            parse_verification_keys(r#"{"v1":"historical-evidence-key-32-bytes-minimum"}"#, true)
                .expect("valid historical key map");
        assert_eq!(
            keys,
            vec![(
                "v1".to_owned(),
                "historical-evidence-key-32-bytes-minimum".to_owned()
            )]
        );
    }

    #[test]
    fn production_oidc_issuers_use_a_clean_https_origin() {
        assert!(valid_https_issuer("https://identity.example.com"));
        assert!(valid_https_issuer("https://identity.example.com/tenant"));
        assert!(!valid_https_issuer("http://identity.example.com"));
        assert!(!valid_https_issuer(
            "https://user:secret@identity.example.com"
        ));
        assert!(!valid_https_issuer(
            "https://identity.example.com?tenant=other"
        ));
    }

    #[test]
    fn builds_an_encoded_tls_database_url_from_secret_components() {
        let url = database_url_from_parts(
            "openrm.cluster.us-east-2.rds.amazonaws.com",
            5432,
            "openrm",
            "openrm_user",
            "p@ss word:/safe",
            "verify-full",
            Some("/etc/ssl/certs/aws-rds-us-east-2-bundle.pem"),
        )
        .expect("valid database components");

        assert_eq!(
            url,
            "postgres://openrm_user:p%40ss%20word%3A%2Fsafe@openrm.cluster.us-east-2.rds.amazonaws.com:5432/openrm?sslmode=verify-full&sslrootcert=%2Fetc%2Fssl%2Fcerts%2Faws-rds-us-east-2-bundle.pem"
        );
    }

    #[test]
    fn rejects_unsafe_database_names_and_weak_ssl_modes() {
        assert!(
            database_url_from_parts(
                "db.example.com",
                5432,
                "openrm/other",
                "user",
                "secret",
                "verify-full",
                None,
            )
            .is_err()
        );
        assert!(
            database_url_from_parts(
                "db.example.com",
                5432,
                "openrm",
                "user",
                "secret",
                "disable",
                None,
            )
            .is_err()
        );
        assert!(
            database_url_from_parts(
                "db.example.com",
                5432,
                "openrm",
                "user",
                "secret",
                "verify-full",
                Some("relative/ca.pem"),
            )
            .is_err()
        );
    }
}
