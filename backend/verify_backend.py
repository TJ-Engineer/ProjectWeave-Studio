from app import app, db, Issue

def verify():
    with app.app_context():
        issues = Issue.query.all()
        print(f"Found {len(issues)} issues.")
        for issue in issues:
            print(f"ID: {issue.id}, Type: {issue.issue_type}, Title: {issue.title}")
            if not issue.issue_type:
                print(f"❌ Issue {issue.id} missing issue_type!")
                return
        print("✅ All issues have issue_type.")

if __name__ == "__main__":
    verify()
