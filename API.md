# Issue Tracker API Documentation

## Base URL
```
http://localhost:3002/api
```

## Endpoints

### Health Check

**GET** `/health`

Check if the API is running.

**Response:**
```json
{
  "status": "healthy",
  "message": "Issue Tracker API is running"
}
```

---

### Get All Issues

**GET** `/issues`

Retrieve a list of all issues with optional filtering and pagination.

**Query Parameters:**
- `status` (optional): Filter by status (OPEN, IN_PROGRESS, RESOLVED, CLOSED)
- `priority` (optional): Filter by priority (CRITICAL, HIGH, MEDIUM, LOW)
- `project` (optional): Filter by project name
- `assigned_to` (optional): Filter by assignee
- `sort_by` (optional): Field to sort by (default: `created_at`)
- `sort_order` (optional): Sort order - `asc` or `desc` (default: `desc`)
- `page` (optional): Page number (default: 1)
- `per_page` (optional): Items per page (default: 100)

**Example Request:**
```bash
curl "http://localhost:3002/api/issues?status=OPEN&priority=HIGH"
```

**Response:**
```json
{
  "issues": [
    {
      "id": 1,
      "title": "Fix login bug",
      "description": "Users cannot log in",
      "priority": "HIGH",
      "status": "OPEN",
      "created_at": "2025-11-28T15:00:00",
      "updated_at": "2025-11-28T15:00:00",
      "assigned_to": "John",
      "tags": ["bug", "security"],
      "project": "WebApp"
    }
  ],
  "total": 1,
  "page": 1,
  "per_page": 100,
  "pages": 1
}
```

---

### Get Single Issue

**GET** `/issues/:id`

Retrieve details of a specific issue.

**Example Request:**
```bash
curl http://localhost:3002/api/issues/1
```

**Response:**
```json
{
  "id": 1,
  "title": "Fix login bug",
  "description": "Users cannot log in",
  "priority": "HIGH",
  "status": "OPEN",
  "created_at": "2025-11-28T15:00:00",
  "updated_at": "2025-11-28T15:00:00",
  "assigned_to": "John",
  "tags": ["bug", "security"],
  "project": "WebApp"
}
```

---

### Create Issue

**POST** `/issues`

Create a new issue.

**Request Body:**
```json
{
  "title": "Fix login bug",
  "description": "Users cannot log in with special characters",
  "priority": "HIGH",
  "status": "OPEN",
  "project": "WebApp",
  "assigned_to": "John",
  "tags": ["bug", "security"]
}
```

**Example Request:**
```bash
curl -X POST http://localhost:3002/api/issues \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Fix login bug",
    "description": "Users cannot log in",
    "priority": "HIGH",
    "status": "OPEN",
    "project": "WebApp",
    "assigned_to": "John",
    "tags": ["bug", "security"]
  }'
```

**Response:** (201 Created)
```json
{
  "id": 8,
  "title": "Fix login bug",
  "description": "Users cannot log in",
  "priority": "HIGH",
  "status": "OPEN",
  "created_at": "2025-11-28T21:30:00",
  "updated_at": "2025-11-28T21:30:00",
  "assigned_to": "John",
  "tags": ["bug", "security"],
  "project": "WebApp"
}
```

---

### Update Issue

**PUT** `/issues/:id`

Update an existing issue. You can update any fields.

**Request Body:**
```json
{
  "title": "Updated title",
  "status": "IN_PROGRESS",
  "assigned_to": "Sarah"
}
```

**Example Request:**
```bash
curl -X PUT http://localhost:3002/api/issues/1 \
  -H "Content-Type: application/json" \
  -d '{
    "status": "IN_PROGRESS",
    "assigned_to": "Sarah"
  }'
```

**Response:** (200 OK)
Returns the updated issue object.

---

### Update Issue Status

**PATCH** `/issues/:id/status`

Update only the status of an issue (quick status change).

**Request Body:**
```json
{
  "status": "IN_PROGRESS"
}
```

**Example Request:**
```bash
curl -X PATCH http://localhost:3002/api/issues/1/status \
  -H "Content-Type: application/json" \
  -d '{"status": "RESOLVED"}'
```

**Response:** (200 OK)
Returns the updated issue object.

---

### Delete Issue

**DELETE** `/issues/:id`

Delete an issue.

**Example Request:**
```bash
curl -X DELETE http://localhost:3002/api/issues/1
```

**Response:** (200 OK)
```json
{
  "message": "Issue deleted successfully"
}
```

---

### Get Statistics

**GET** `/issues/stats`

Get statistics about all issues.

**Example Request:**
```bash
curl http://localhost:3002/api/issues/stats
```

**Response:**
```json
{
  "total": 7,
  "by_status": {
    "OPEN": 5,
    "IN_PROGRESS": 1,
    "RESOLVED": 1,
    "CLOSED": 0
  },
  "by_priority": {
    "CRITICAL": 1,
    "HIGH": 3,
    "MEDIUM": 2,
    "LOW": 1
  },
  "projects": ["VectorIQ", "IssueTracker"]
}
```

---

### Get Projects

**GET** `/projects`

Get a list of all distinct projects.

**Example Request:**
```bash
curl http://localhost:3002/api/projects
```

**Response:**
```json
["VectorIQ", "IssueTracker", "WebApp"]
```

---

## Status Values

- `OPEN` - Issue is newly created and not yet started
- `IN_PROGRESS` - Issue is being actively worked on
- `RESOLVED` - Issue has been resolved but not yet closed
- `CLOSED` - Issue is completed and closed

## Priority Values

- `CRITICAL` - Urgent, blocking issue
- `HIGH` - Important, should be addressed soon
- `MEDIUM` - Normal priority
- `LOW` - Nice to have, can be deferred

## Error Responses

### 400 Bad Request
```json
{
  "error": "Title is required"
}
```

### 404 Not Found
```json
{
  "error": "Issue not found"
}
```

### 500 Internal Server Error
```json
{
  "error": "Database error message"
}
```

## CORS

CORS is enabled for all origins in development mode. All endpoints return the `Access-Control-Allow-Origin: *` header.

## Rate Limiting

Currently no rate limiting is implemented. This is suitable for internal/development use.

## Authentication

Currently no authentication is required. All endpoints are publicly accessible. This is suitable for localhost/internal use only.
