import axios from 'axios';

const API_BASE_URL = 'http://localhost:5000/api';

const api = axios.create({
    baseURL: API_BASE_URL,
    headers: {
        'Content-Type': 'application/json',
    },
});

export const issueApi = {
    // Get all issues with filtering
    getIssues: async (params) => {
        const response = await api.get('/issues', { params });
        return response.data;
    },

    // Get single issue
    getIssue: async (id) => {
        const response = await api.get(`/issues/${id}`);
        return response.data;
    },

    // Create new issue
    createIssue: async (data) => {
        const response = await api.post('/issues', data);
        return response.data;
    },

    // Update issue
    updateIssue: async (id, data) => {
        const response = await api.put(`/issues/${id}`, data);
        return response.data;
    },

    // Update issue status
    updateIssueStatus: async (id, status) => {
        const response = await api.patch(`/issues/${id}/status`, { status });
        return response.data;
    },

    // Delete issue
    deleteIssue: async (id) => {
        const response = await api.delete(`/issues/${id}`);
        return response.data;
    },

    // Get statistics
    getStats: async () => {
        const response = await api.get('/issues/stats');
        return response.data;
    },

    // Get projects
    getProjects: async () => {
        const response = await api.get('/projects');
        return response.data;
    },
};

export default api;
