docker commit issuetracker-frontend angelo4509/issuetracker-frontend:latest
docker commit issuetracker-backend angelo4509/issuetracker-backend:latest
docker tag angelo4509/issuetracker-frontend angelo4509/issuetracker-frontend:latest
docker tag angelo4509/issuetracker-backend angelo4509/issuetracker-backend:latest
docker push angelo4509/issuetracker-frontend:latest
docker push angelo4509/issuetracker-backend:latest
