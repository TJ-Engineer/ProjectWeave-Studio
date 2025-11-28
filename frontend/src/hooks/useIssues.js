import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { issueApi } from '../api/issueApi';

// Get all issues
export const useIssues = (params = {}) => {
    return useQuery({
        queryKey: ['issues', params],
        queryFn: () => issueApi.getIssues(params),
    });
};

// Get single issue
export const useIssue = (id) => {
    return useQuery({
        queryKey: ['issue', id],
        queryFn: () => issueApi.getIssue(id),
        enabled: !!id,
    });
};

// Create issue
export const useCreateIssue = () => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: issueApi.createIssue,
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['issues'] });
            queryClient.invalidateQueries({ queryKey: ['stats'] });
        },
    });
};

// Update issue
export const useUpdateIssue = () => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ id, data }) => issueApi.updateIssue(id, data),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['issues'] });
            queryClient.invalidateQueries({ queryKey: ['stats'] });
        },
    });
};

// Update issue status
export const useUpdateIssueStatus = () => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ id, status }) => issueApi.updateIssueStatus(id, status),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['issues'] });
            queryClient.invalidateQueries({ queryKey: ['stats'] });
        },
    });
};

// Delete issue
export const useDeleteIssue = () => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: issueApi.deleteIssue,
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['issues'] });
            queryClient.invalidateQueries({ queryKey: ['stats'] });
        },
    });
};

// Get statistics
export const useStats = () => {
    return useQuery({
        queryKey: ['stats'],
        queryFn: issueApi.getStats,
    });
};

// Get projects
export const useProjects = () => {
    return useQuery({
        queryKey: ['projects'],
        queryFn: issueApi.getProjects,
    });
};
