import { useState } from 'react';
import { Plus, Trash2, Edit } from 'lucide-react';
import { useIssues, useCreateIssue, useUpdateIssue, useDeleteIssue } from '../hooks/useIssues';
import { StatsPanel } from '../components/StatsPanel';
import { FilterPanel } from '../components/FilterPanel';
import { IssueCard } from '../components/IssueCard';
import { IssueModal } from '../components/IssueModal';

export const Dashboard = () => {
    const [filters, setFilters] = useState({});
    const [selectedIssue, setSelectedIssue] = useState(null);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [isEditing, setIsEditing] = useState(false);

    const { data: issuesData, isLoading } = useIssues(filters);
    const createMutation = useCreateIssue();
    const updateMutation = useUpdateIssue();
    const deleteMutation = useDeleteIssue();

    const handleCreateIssue = () => {
        setSelectedIssue(null);
        setIsEditing(false);
        setIsModalOpen(true);
    };

    const handleEditIssue = (issue) => {
        setSelectedIssue(issue);
        setIsEditing(true);
        setIsModalOpen(true);
    };

    const handleSaveIssue = async (data) => {
        try {
            if (isEditing && selectedIssue) {
                await updateMutation.mutateAsync({ id: selectedIssue.id, data });
            } else {
                await createMutation.mutateAsync(data);
            }
            setIsModalOpen(false);
            setSelectedIssue(null);
        } catch (error) {
            console.error('Error saving issue:', error);
        }
    };

    const handleDeleteIssue = async (issueId) => {
        if (window.confirm('Are you sure you want to delete this issue?')) {
            try {
                await deleteMutation.mutateAsync(issueId);
            } catch (error) {
                console.error('Error deleting issue:', error);
            }
        }
    };

    return (
        <div className="min-h-screen bg-gray-50">
            {/* Header */}
            <header className="bg-white shadow-sm">
                <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
                    <div className="flex items-center justify-between">
                        <div>
                            <h1 className="text-2xl font-bold text-gray-900">Issue Tracker</h1>
                            <p className="text-sm text-gray-600">Manage your project issues</p>
                        </div>
                        <button
                            onClick={handleCreateIssue}
                            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition"
                        >
                            <Plus size={20} />
                            New Issue
                        </button>
                    </div>
                </div>
            </header>

            {/* Main Content */}
            <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
                {/* Stats */}
                <div className="mb-8">
                    <StatsPanel />
                </div>

                {/* Content Grid */}
                <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
                    {/* Filters Sidebar */}
                    <div className="lg:col-span-1">
                        <FilterPanel filters={filters} onFilterChange={setFilters} />
                    </div>

                    {/* Issues List */}
                    <div className="lg:col-span-3">
                        <div className="mb-4">
                            <h2 className="text-lg font-semibold text-gray-900">
                                Issues {issuesData && `(${issuesData.total})`}
                            </h2>
                        </div>

                        {isLoading ? (
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                {[...Array(6)].map((_, i) => (
                                    <div key={i} className="bg-white rounded-lg shadow p-4 animate-pulse">
                                        <div className="h-4 bg-gray-200 rounded w-3/4 mb-2"></div>
                                        <div className="h-3 bg-gray-200 rounded w-1/2"></div>
                                    </div>
                                ))}
                            </div>
                        ) : issuesData && issuesData.issues.length > 0 ? (
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                {issuesData.issues.map((issue) => (
                                    <div key={issue.id} className="relative group">
                                        <IssueCard issue={issue} onClick={handleEditIssue} />
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                handleDeleteIssue(issue.id);
                                            }}
                                            className="absolute top-2 right-2 p-2 bg-red-100 text-red-600 rounded-md opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-200"
                                            title="Delete issue"
                                        >
                                            <Trash2 size={16} />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div className="bg-white rounded-lg shadow p-12 text-center">
                                <p className="text-gray-500">No issues found</p>
                                <button
                                    onClick={handleCreateIssue}
                                    className="mt-4 text-blue-600 hover:text-blue-700"
                                >
                                    Create your first issue
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            </main>

            {/* Issue Modal */}
            {isModalOpen && (
                <IssueModal
                    issue={isEditing ? selectedIssue : null}
                    onClose={() => {
                        setIsModalOpen(false);
                        setSelectedIssue(null);
                    }}
                    onSave={handleSaveIssue}
                    isLoading={createMutation.isPending || updateMutation.isPending}
                />
            )}
        </div>
    );
};
