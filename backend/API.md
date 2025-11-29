# Issue Tracker API Documentation

Base URL: `http://localhost:5000/api`

## Endpoints

### Health Check
Check if the API is running.

- **URL**: `/health`
- **Method**: `GET`
- **Success Response**:
  - **Code**: 200 OK
  - **Content**: `{ "status": "healthy", "message": "Issue Tracker API is running" }`

---

### Issues

#### Get All Issues
Retrieve a paginated list of issues with optional filtering and sorting.

- **URL**: `/issues`
- **Method**: `GET`
- **Query Parameters**:
  - `page` (int, default: 1): Page number.
  - `per_page` (int, default: 100): Items per page.
  - `status` (string, optional): Filter by status (OPEN, IN_PROGRESS, RESOLVED, CLOSED).
  - `priority` (string, optional): Filter by priority (LOW, MEDIUM, HIGH, CRITICAL).
  - `project` (string, optional): Filter by project name.
  - `assigned_to` (string, optional): Filter by assignee.
  - `sort_by` (string, default: 'created_at'): Field to sort by.
  - `sort_order` (string, default: 'desc'): 'asc' or 'desc'.

- **Success Response**:
  - **Code**: 200 OK
  - **Content**:
    ```json
    {
      "issues": [ ... ],
      "total": 15,
      "page": 1,
      "per_page": 100,
      "pages": 1
    }
    ```

#### Get Single Issue
Retrieve details of a specific issue.

- **URL**: `/issues/:id`
- **Method**: `GET`
- **Success Response**:
  - **Code**: 200 OK
  - **Content**: `{ "id": 1, "title": "...", ... }`
- **Error Response**:
  - **Code**: 404 Not Found

#### Create Issue
Create a new issue.

- **URL**: `/issues`
- **Method**: `POST`
- **Data Params**:
  ```json
  {
    "title": "Fix login bug",
    "description": "Login button not working on mobile",
    "priority": "HIGH",
    "status": "OPEN",
    "project": "IssueTracker",
    "assigned_to": "John Doe",
    "tags": ["bug", "frontend"],
    "issue_type": "Bug"
  }
  ```
- **Success Response**:
  - **Code**: 201 Created
  - **Content**: `{ "id": 12, ... }`

#### Update Issue
Update an existing issue.

- **URL**: `/issues/:id`
- **Method**: `PUT`
- **Data Params**: (Any subset of fields)
  ```json
  {
    "priority": "CRITICAL",
    "assigned_to": "Jane Smith"
  }
  ```
- **Success Response**:
  - **Code**: 200 OK

#### Update Issue Status
Quickly update just the status of an issue (useful for drag-and-drop).

- **URL**: `/issues/:id/status`
- **Method**: `PATCH`
- **Data Params**:
  ```json
  {
    "status": "IN_PROGRESS"
  }
  ```
- **Success Response**:
  - **Code**: 200 OK

#### Delete Issue
Delete an issue permanently.

- **URL**: `/issues/:id`
- **Method**: `DELETE`
- **Success Response**:
  - **Code**: 200 OK
  - **Content**: `{ "message": "Issue deleted successfully" }`

---

### Statistics & Metadata

#### Get Statistics
Get counts of issues by status and priority.

- **URL**: `/issues/stats`
- **Method**: `GET`
- **Success Response**:
  - **Code**: 200 OK
  - **Content**:
    ```json
    {
      "total": 50,
      "by_status": { "OPEN": 20, "IN_PROGRESS": 15, ... },
      "by_priority": { "HIGH": 10, ... },
      "projects": ["VectorIQ", "IssueTracker"]
    }
    ```

#### Get Projects
Get a list of all unique project names.

- **URL**: `/projects`
- **Method**: `GET`
- **Success Response**:
  - **Code**: 200 OK
  - **Content**: `["VectorIQ", "IssueTracker"]`
