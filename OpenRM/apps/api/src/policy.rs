use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Action {
    Read,
    Write,
    Review,
    Administer,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Principal {
    pub subject: String,
    pub organization_id: Uuid,
    pub roles: Vec<String>,
}

#[derive(Clone, Default)]
pub struct PolicyEngine;

impl PolicyEngine {
    pub fn allows(
        &self,
        principal: &Principal,
        action: Action,
        resource_organization: Uuid,
    ) -> bool {
        if principal.organization_id != resource_organization {
            return false;
        }

        principal.roles.iter().any(|role| match role.as_str() {
            "administrator" => true,
            "author" => matches!(action, Action::Read | Action::Write),
            "reviewer" => matches!(action, Action::Read | Action::Review),
            "viewer" => matches!(action, Action::Read),
            _ => false,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{Action, PolicyEngine, Principal};
    use uuid::Uuid;

    fn principal(role: &str, organization_id: Uuid) -> Principal {
        Principal {
            subject: "test-user".to_owned(),
            organization_id,
            roles: vec![role.to_owned()],
        }
    }

    #[test]
    fn deny_by_default_for_unknown_roles() {
        let organization_id = Uuid::new_v4();
        assert!(!PolicyEngine.allows(
            &principal("unknown", organization_id),
            Action::Read,
            organization_id,
        ));
    }

    #[test]
    fn denies_cross_organization_access_even_for_administrators() {
        assert!(!PolicyEngine.allows(
            &principal("administrator", Uuid::new_v4()),
            Action::Administer,
            Uuid::new_v4(),
        ));
    }

    #[test]
    fn author_can_write_but_cannot_review() {
        let organization_id = Uuid::new_v4();
        let author = principal("author", organization_id);
        assert!(PolicyEngine.allows(&author, Action::Write, organization_id));
        assert!(!PolicyEngine.allows(&author, Action::Review, organization_id));
    }

    #[test]
    fn reviewer_and_viewer_permissions_are_read_only_for_authoring() {
        let organization_id = Uuid::new_v4();
        let reviewer = principal("reviewer", organization_id);
        let viewer = principal("viewer", organization_id);
        assert!(PolicyEngine.allows(&reviewer, Action::Read, organization_id));
        assert!(PolicyEngine.allows(&reviewer, Action::Review, organization_id));
        assert!(!PolicyEngine.allows(&reviewer, Action::Write, organization_id));
        assert!(PolicyEngine.allows(&viewer, Action::Read, organization_id));
        assert!(!PolicyEngine.allows(&viewer, Action::Review, organization_id));
        assert!(!PolicyEngine.allows(&viewer, Action::Write, organization_id));
    }
}
