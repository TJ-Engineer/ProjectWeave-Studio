# Issue Tracker

A lightweight, web-based issue tracking system built with Flask and SQLite. Perfect for managing bugs, features, and tasks across multiple projects.

## 🚀 Features

- ✅ Full CRUD operations for issues
- 🔍 Advanced filtering (status, priority, project, assignee)
- 📊 Statistics and dashboard data
- 🏷️ Tag support for categorization
- 📁 Multi-project support
- 🔄 RESTful API
- 🐳 Docker deployment

## 🏗️ Architecture

**Backend Stack:**
- Flask (Python web framework)
- SQLAlchemy (ORM)
- SQLite (Database)
- Flask-CORS (Cross-origin support)

**Deployment:**
- Docker + Docker Compose

## 📋 Database Schema

```sql
CREATE TABLE issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    priority TEXT NOT NULL,        -- CRITICAL, HIGH, MEDIUM, LOW
    status TEXT NOT NULL,           -- OPEN, IN_PROGRESS, RESOLVED, CLOSED
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    assigned_to TEXT,
    tags TEXT,                      -- JSON array
    project TEXT DEFAULT 'VectorIQ'
);
```

## 🔌 API Endpoints

### Issues

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/issues` | List all issues (with filtering) |
| GET | `/api/issues/:id` | Get single issue |
| POST | `/api/issues` | Create new issue |
| PUT | `/api/issues/:id` | Update issue |
| DELETE | `/api/issues/:id` | Delete issue |
| PATCH | `/api/issues/:id/status` | Update status only |

### Statistics & Info

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/issues/stats` | Get issue statistics |
| GET | `/api/projects` | List all projects |
| GET | `/api/health` | Health check |

### Query Parameters

**Filtering:**
- `status` - Filter by status (OPEN, IN_PROGRESS, RESOLVED, CLOSED)
- `priority` - Filter by priority (CRITICAL, HIGH, MEDIUM, LOW)
- `project` - Filter by project name
- `assigned_to` - Filter by assignee

**Sorting:**
- `sort_by` - Field to sort by (default: created_at)
- `sort_order` - Sort order: asc or desc (default: desc)

**Pagination:**
- `page` - Page number (default: 1)
- `per_page` - Items per page (default: 100)

## 🚀 Quick Start

### Using Docker (Recommended)

```bash
# Build and start
docker-compose up -d

# View logs
docker-compose logs -f backend

# Stop
docker-compose down
```

The API will be available at `http://localhost:3002`

### Manual Setup

```bash
# Navigate to backend
cd backend

# Create virtual environment
python -m venv venv
venv\Scripts\activate  # Windows
source venv/bin/activate  # Linux/Mac

# Install dependencies
pip install -r requirements.txt

# Run the app
python app.py
```

The API will be available at `http://localhost:5001`

## 📝 Usage Examples

### Create an Issue

```bash
curl -X POST http://localhost:3001/api/issues \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Fix login bug",
    "description": "Users cannot log in with special characters",
    "priority": "HIGH",
    "status": "OPEN",
    "project": "WebApp",
    "assigned_to": "John",
    "tags": ["bug", "security"]
  }'
```

### Get All Issues

```bash
curl http://localhost:3001/api/issues
```

### Filter Issues

```bash
# Get all open high-priority issues
curl "http://localhost:3001/api/issues?status=OPEN&priority=HIGH"

# Get all issues for VectorIQ project
curl "http://localhost:3001/api/issues?project=VectorIQ"
```

### Update Issue Status

```bash
curl -X PATCH http://localhost:3001/api/issues/1/status \
  -H "Content-Type: application/json" \
  -d '{"status": "IN_PROGRESS"}'
```

### Get Statistics

```bash
curl http://localhost:3001/api/issues/stats
```

## 🗄️ Database Seeding

To populate the database with sample issues:

```bash
# Inside the backend container
docker-compose exec backend python seed_data.py

# Or manually
cd backend
python seed_data.py
```

## 📂 Project Structure

```
IssueTracker/
├── backend/
│   ├── app.py              # Flask application
│   ├── models.py           # SQLAlchemy models
│   ├── seed_data.py        # Database seeding
│   ├── requirements.txt    # Python dependencies
│   └── Dockerfile          # Docker configuration
├── docker-compose.yml      # Docker Compose config
├── .gitignore
└── README.md
```

## 🔧 Configuration

The application uses the following default configuration:

- **Port**: 3001 (mapped from container port 5000) for frontend (dev value), backend mapped to 5001
- **Database**: SQLite (stored in Docker volume `issue-data`)
- **CORS**: Enabled for all origins (development mode)

## 🛠️ Development

### Rebuilding the Container

```bash
docker-compose build backend
docker-compose up -d
```

### Accessing the Database

The SQLite database is persisted in a Docker volume. To access it:

```bash
docker-compose exec backend sh
cd instance
sqlite3 issues.db
```

## 📊 Response Formats

### Issue Object

```json
{
  "id": 1,
  "title": "Fix deinterleaver",
  "description": "Separate SA-10 and Marine signals",
  "priority": "CRITICAL",
  "status": "IN_PROGRESS",
  "created_at": "2025-11-28T15:00:00",
  "updated_at": "2025-11-28T15:30:00",
  "assigned_to": "Claude",
  "tags": ["deinterleaver", "TIC"],
  "project": "VectorIQ"
}
```

### Statistics Response

```json
{
  "total": 10,
  "by_status": {
    "OPEN": 5,
    "IN_PROGRESS": 3,
    "RESOLVED": 1,
    "CLOSED": 1
  },
  "by_priority": {
    "CRITICAL": 2,
    "HIGH": 3,
    "MEDIUM": 4,
    "LOW": 1
  },
  "projects": ["VectorIQ", "IssueTracker"]
}
```

## 🎯 Roadmap

- [ ] React frontend (Day 2)
- [ ] Advanced search
- [ ] Comments/discussion threads
- [ ] File attachments
- [ ] Email notifications
- [ ] User authentication
- [ ] Activity timeline

## 📄 License

MIT

## 👤 Author

Created for VectorIQ project management
