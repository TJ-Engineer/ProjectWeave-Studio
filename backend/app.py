"""
Flask REST API for Issue Tracker
"""
from flask import Flask, request, jsonify
from flask_cors import CORS
from models import db, Issue
import os

app = Flask(__name__)
CORS(app)  # Enable CORS for all routes

# Configuration
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///issues.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

# Initialize database
db.init_app(app)

# Create tables
with app.app_context():
    db.create_all()


@app.route('/api/health', methods=['GET'])
def health_check():
    """Health check endpoint"""
    return jsonify({'status': 'healthy', 'message': 'Issue Tracker API is running'}), 200


@app.route('/api/issues', methods=['GET'])
def get_issues():
    """Get all issues with optional filtering"""
    # Query parameters
    status = request.args.get('status')
    priority = request.args.get('priority')
    project = request.args.get('project')
    assigned_to = request.args.get('assigned_to')
    
    # Build query
    query = Issue.query
    
    if status:
        query = query.filter_by(status=status)
    if priority:
        query = query.filter_by(priority=priority)
    if project:
        query = query.filter_by(project=project)
    if assigned_to:
        query = query.filter_by(assigned_to=assigned_to)
    
    # Sorting
    sort_by = request.args.get('sort_by', 'created_at')
    sort_order = request.args.get('sort_order', 'desc')
    
    if sort_order == 'desc':
        query = query.order_by(getattr(Issue, sort_by).desc())
    else:
        query = query.order_by(getattr(Issue, sort_by).asc())
    
    # Pagination
    page = request.args.get('page', 1, type=int)
    per_page = request.args.get('per_page', 100, type=int)
    
    paginated = query.paginate(page=page, per_page=per_page, error_out=False)
    
    return jsonify({
        'issues': [issue.to_dict() for issue in paginated.items],
        'total': paginated.total,
        'page': page,
        'per_page': per_page,
        'pages': paginated.pages
    }), 200


@app.route('/api/issues/<int:issue_id>', methods=['GET'])
def get_issue(issue_id):
    """Get a single issue by ID"""
    issue = Issue.query.get(issue_id)
    if not issue:
        return jsonify({'error': 'Issue not found'}), 404
    return jsonify(issue.to_dict()), 200


@app.route('/api/issues', methods=['POST'])
def create_issue():
    """Create a new issue"""
    data = request.get_json()
    
    if not data or 'title' not in data:
        return jsonify({'error': 'Title is required'}), 400
    
    issue = Issue.from_dict(data)
    
    try:
        db.session.add(issue)
        db.session.commit()
        return jsonify(issue.to_dict()), 201
    except Exception as e:
        db.session.rollback()
        return jsonify({'error': str(e)}), 500


@app.route('/api/issues/<int:issue_id>', methods=['PUT'])
def update_issue(issue_id):
    """Update an existing issue"""
    issue = Issue.query.get(issue_id)
    if not issue:
        return jsonify({'error': 'Issue not found'}), 404
    
    data = request.get_json()
    if not data:
        return jsonify({'error': 'No data provided'}), 400
    
    issue.update_from_dict(data)
    
    try:
        db.session.commit()
        return jsonify(issue.to_dict()), 200
    except Exception as e:
        db.session.rollback()
        return jsonify({'error': str(e)}), 500


@app.route('/api/issues/<int:issue_id>/status', methods=['PATCH'])
def update_issue_status(issue_id):
    """Update only the status of an issue"""
    issue = Issue.query.get(issue_id)
    if not issue:
        return jsonify({'error': 'Issue not found'}), 404
    
    data = request.get_json()
    if not data or 'status' not in data:
        return jsonify({'error': 'Status is required'}), 400
    
    issue.status = data['status']
    
    try:
        db.session.commit()
        return jsonify(issue.to_dict()), 200
    except Exception as e:
        db.session.rollback()
        return jsonify({'error': str(e)}), 500


@app.route('/api/issues/<int:issue_id>', methods=['DELETE'])
def delete_issue(issue_id):
    """Delete an issue"""
    issue = Issue.query.get(issue_id)
    if not issue:
        return jsonify({'error': 'Issue not found'}), 404
    
    try:
        db.session.delete(issue)
        db.session.commit()
        return jsonify({'message': 'Issue deleted successfully'}), 200
    except Exception as e:
        db.session.rollback()
        return jsonify({'error': str(e)}), 500


@app.route('/api/issues/stats', methods=['GET'])
def get_stats():
    """Get statistics about issues"""
    total = Issue.query.count()
    
    stats = {
        'total': total,
        'by_status': {
            'OPEN': Issue.query.filter_by(status='OPEN').count(),
            'IN_PROGRESS': Issue.query.filter_by(status='IN_PROGRESS').count(),
            'RESOLVED': Issue.query.filter_by(status='RESOLVED').count(),
            'CLOSED': Issue.query.filter_by(status='CLOSED').count()
        },
        'by_priority': {
            'CRITICAL': Issue.query.filter_by(priority='CRITICAL').count(),
            'HIGH': Issue.query.filter_by(priority='HIGH').count(),
            'MEDIUM': Issue.query.filter_by(priority='MEDIUM').count(),
            'LOW': Issue.query.filter_by(priority='LOW').count()
        }
    }
    
    # Get projects
    projects = db.session.query(Issue.project).distinct().all()
    stats['projects'] = [p[0] for p in projects]
    
    return jsonify(stats), 200


@app.route('/api/projects', methods=['GET'])
def get_projects():
    """Get list of all projects"""
    projects = db.session.query(Issue.project).distinct().all()
    return jsonify([p[0] for p in projects]), 200


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
