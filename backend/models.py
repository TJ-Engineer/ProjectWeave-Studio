"""
Database models for Issue Tracker
"""
from datetime import datetime
from flask_sqlalchemy import SQLAlchemy
import json

db = SQLAlchemy()

class Issue(db.Model):
    """Issue model for tracking bugs, features, and tasks"""
    __tablename__ = 'issues'
    
    id = db.Column(db.Integer, primary_key=True)
    title = db.Column(db.String(200), nullable=False)
    description = db.Column(db.Text, nullable=True)
    priority = db.Column(db.String(20), nullable=False, default='MEDIUM')  # CRITICAL, HIGH, MEDIUM, LOW
    status = db.Column(db.String(20), nullable=False, default='OPEN')  # OPEN, IN_PROGRESS, RESOLVED, CLOSED
    issue_type = db.Column(db.String(20), nullable=False, default='Task')  # Epic, Story, Task, Bug
    created_at = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)
    assigned_to = db.Column(db.String(100), nullable=True)
    tags = db.Column(db.Text, nullable=True)  # JSON array stored as text
    project = db.Column(db.String(100), nullable=False, default='VectorIQ')
    
    def __repr__(self):
        return f'<Issue {self.id}: {self.title}>'
    
    def to_dict(self):
        """Convert issue to dictionary for JSON serialization"""
        return {
            'id': self.id,
            'title': self.title,
            'description': self.description,
            'priority': self.priority,
            'status': self.status,
            'issue_type': self.issue_type,
            'created_at': self.created_at.isoformat() if self.created_at else None,
            'updated_at': self.updated_at.isoformat() if self.updated_at else None,
            'assigned_to': self.assigned_to,
            'tags': json.loads(self.tags) if self.tags else [],
            'project': self.project
        }
    
    @staticmethod
    def from_dict(data):
        """Create issue from dictionary"""
        issue = Issue()
        if 'title' in data:
            issue.title = data['title']
        if 'description' in data:
            issue.description = data['description']
        if 'priority' in data:
            issue.priority = data['priority']
        if 'status' in data:
            issue.status = data['status']
        if 'issue_type' in data:
            issue.issue_type = data['issue_type']
        if 'assigned_to' in data:
            issue.assigned_to = data['assigned_to']
        if 'tags' in data:
            issue.tags = json.dumps(data['tags']) if isinstance(data['tags'], list) else data['tags']
        if 'project' in data:
            issue.project = data['project']
        return issue
    
    def update_from_dict(self, data):
        """Update issue from dictionary"""
        if 'title' in data:
            self.title = data['title']
        if 'description' in data:
            self.description = data['description']
        if 'priority' in data:
            self.priority = data['priority']
        if 'status' in data:
            self.status = data['status']
        if 'issue_type' in data:
            self.issue_type = data['issue_type']
        if 'assigned_to' in data:
            self.assigned_to = data['assigned_to']
        if 'tags' in data:
            self.tags = json.dumps(data['tags']) if isinstance(data['tags'], list) else data['tags']
        if 'project' in data:
            self.project = data['project']
        self.updated_at = datetime.utcnow()
