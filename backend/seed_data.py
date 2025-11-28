"""
Seed database with initial issues from VectorIQ project
"""
from app import app, db
from models import Issue
import json

def seed_database():
    """Seed the database with initial issues"""
    with app.app_context():
        # Clear existing data
        Issue.query.delete()
        
        # Sample issues based on VectorIQ project
        issues = [
            {
                'title': 'Deinterleaver Signal Separation',
                'description': 'Fix deinterleaver to properly separate SA-10 and Marine Radar signals. Currently merging signals incorrectly.',
                'priority': 'CRITICAL',
                'status': 'IN_PROGRESS',
                'project': 'VectorIQ',
                'assigned_to': 'Claude',
                'tags': json.dumps(['deinterleaver', 'signal-processing', 'TIC'])
            },
            {
                'title': 'Alert Bug - Disabled Threats',
                'description': 'System generating alerts for disabled threats. Need to check awg.enabled flag in threat matcher.',
                'priority': 'HIGH',
                'status': 'OPEN',
                'project': 'VectorIQ',
                'tags': json.dumps(['alerts', 'TIC', 'bug'])
            },
            {
                'title': 'Pulse Width Measurement',
                'description': 'Implement energy-based pulse width measurement instead of hardcoded values. Add PulseState struct to SdrInterface.',
                'priority': 'HIGH',
                'status': 'OPEN',
                'project': 'VectorIQ',
                'tags': json.dumps(['SPD', 'signal-processing', 'measurement'])
            },
            {
                'title': 'Weighted Averaging with Outlier Rejection',
                'description': 'Add weighted_average_with_outlier_rejection() to pulse_deinterleaver.py for more stable parameter tracking.',
                'priority': 'MEDIUM',
                'status': 'OPEN',
                'project': 'VectorIQ',
                'assigned_to': 'Claude',
                'tags': json.dumps(['deinterleaver', 'TIC', 'enhancement'])
            },
            {
                'title': 'Dashboard Histogram Display',
                'description': 'Fix waterfall display frequency labels and expand range to 500MHz-12GHz.',
                'priority': 'LOW',
                'status': 'RESOLVED',
                'project': 'VectorIQ',
                'tags': json.dumps(['dashboard', 'UI', 'frontend'])
            },
            {
                'title': 'Threat Library Web Editor',
                'description': 'Create web-based tool to edit threat_lib.json for easier threat management.',
                'priority': 'MEDIUM',
                'status': 'OPEN',
                'project': 'VectorIQ',
                'tags': json.dumps(['tools', 'threat-library', 'frontend'])
            },
            {
                'title': 'Issue Tracker Frontend',
                'description': 'Build React frontend with Jira-style UI for issue management.',
                'priority': 'HIGH',
                'status': 'OPEN',
                'project': 'IssueTracker',
                'assigned_to': 'Claude',
                'tags': json.dumps(['frontend', 'react', 'UI'])
            }
        ]
        
        for issue_data in issues:
            issue = Issue.from_dict(issue_data)
            db.session.add(issue)
        
        db.session.commit()
        print(f"✅ Seeded database with {len(issues)} issues")

if __name__ == '__main__':
    seed_database()
