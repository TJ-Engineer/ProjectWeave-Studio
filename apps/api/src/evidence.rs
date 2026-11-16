use std::{collections::HashMap, sync::Arc};

use hmac::{Hmac, Mac};
use sha2::Sha256;

#[derive(Clone)]
pub struct EvidenceSigner {
    key: Arc<[u8]>,
    key_id: Arc<str>,
    verification_keys: Arc<HashMap<String, Arc<[u8]>>>,
}

impl EvidenceSigner {
    pub const ALGORITHM: &'static str = "HMAC-SHA256";

    pub fn new(key: impl AsRef<[u8]>, key_id: impl Into<String>) -> Self {
        let key: Arc<[u8]> = Arc::from(key.as_ref());
        let key_id: String = key_id.into();
        let verification_keys = HashMap::from([(key_id.clone(), key.clone())]);
        Self {
            key,
            key_id: Arc::from(key_id),
            verification_keys: Arc::new(verification_keys),
        }
    }

    pub fn with_verification_key(
        mut self,
        key: impl AsRef<[u8]>,
        key_id: impl Into<String>,
    ) -> Self {
        Arc::make_mut(&mut self.verification_keys).insert(key_id.into(), Arc::from(key.as_ref()));
        self
    }

    pub fn development() -> Self {
        Self::new("openrm-development-evidence-key", "development")
    }

    pub fn key_id(&self) -> &str {
        &self.key_id
    }

    pub fn sign(&self, manifest_hash: &str) -> String {
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.key)
            .expect("HMAC accepts keys of any non-empty length");
        mac.update(manifest_hash.as_bytes());
        hex::encode(mac.finalize().into_bytes())
    }

    pub fn verify(&self, manifest_hash: &str, signature: &str) -> bool {
        self.verify_with_key_id(self.key_id(), manifest_hash, signature)
    }

    pub fn verify_with_key_id(&self, key_id: &str, manifest_hash: &str, signature: &str) -> bool {
        let Some(key) = self.verification_keys.get(key_id) else {
            return false;
        };
        let Ok(signature) = hex::decode(signature) else {
            return false;
        };
        let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(key) else {
            return false;
        };
        mac.update(manifest_hash.as_bytes());
        mac.verify_slice(&signature).is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::EvidenceSigner;

    #[test]
    fn signs_and_verifies_manifest_hashes() {
        let signer = EvidenceSigner::new("test-key", "test");
        let signature = signer.sign(&"a".repeat(64));
        assert_eq!(signature.len(), 64);
        assert!(signer.verify(&"a".repeat(64), &signature));
        assert!(!signer.verify(&"b".repeat(64), &signature));
    }

    #[test]
    fn verifies_historical_keys_by_identifier() {
        let old_signer = EvidenceSigner::new("old-test-key", "v1");
        let signature = old_signer.sign(&"a".repeat(64));
        let signer = EvidenceSigner::new("current-test-key", "v2")
            .with_verification_key("old-test-key", "v1");

        assert!(signer.verify_with_key_id("v1", &"a".repeat(64), &signature));
        assert!(!signer.verify_with_key_id("v2", &"a".repeat(64), &signature));
        assert!(!signer.verify_with_key_id("missing", &"a".repeat(64), &signature));
    }
}
