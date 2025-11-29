import { useState } from 'react';
import { Plus, Search, Filter, Settings } from 'lucide-react';
import { useIssues, useCreateIssue, useUpdateIssue, useDeleteIssue } from '../hooks/useIssues';
import { IssueCard } from '../components/IssueCard';
import { IssueModal } from '../components/IssueModal';

const COLUMNS = [
    { id: 'OPEN', title: 'To Do', bg: 'bg-gray-50' },
    { id: 'IN_PROGRESS', title: 'In Progress', bg: 'bg-blue-50' },
    { id: 'RESOLVED', title: 'Done', bg: 'bg-green-50' }
];

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

    const getIssuesByStatus = (status) => {
        if (!issuesData?.issues) return [];
        // Map RESOLVED and CLOSED to Done column
        if (status === 'RESOLVED') {
            return issuesData.issues.filter(i => i.status === 'RESOLVED' || i.status === 'CLOSED');
        }
        return issuesData.issues.filter(i => i.status === status);
    };

    return (
        <div className="h-screen flex flex-col bg-white">
            {/* Header */}
            <header className="border-b border-gray-200 px-6 py-3 flex items-center justify-between bg-white">
                <div className="flex items-center gap-4">
                    <div className="w-8 h-8 bg-blue-600 rounded flex items-center justify-center text-white font-bold">
                        IT
                    </div>
                    <div>
                        <h1 className="text-sm font-semibold text-gray-900">Issue Tracker / Board</h1>
                        <p className="text-xs text-gray-500">Sprint 1</p>
                    </div>
                </div>

                <div className="flex items-center gap-3">
                    <div className="relative">
                        <Search className="absolute left-2.5 top-2 text-gray-400" size={16} />
                        <input
                            type="text"
                            placeholder="Search issues..."
                            className="pl-9 pr-4 py-1.5 bg-gray-100 border-transparent rounded text-sm focus:bg-white focus:ring-2 focus:ring-blue-500 transition-all w-64"
                        />
                    </div>
                    <button className="p-2 text-gray-600 hover:bg-gray-100 rounded">
                        <Filter size={18} />
                    </button>
                    <button className="p-2 text-gray-600 hover:bg-gray-100 rounded">
                        <Settings size={18} />
                    </button>
                    <button
                        onClick={handleCreateIssue}
                        className="flex items-center gap-2 px-3 py-1.5 bg-blue-600 text-white text-sm font-medium rounded hover:bg-blue-700 transition"
                    >
                        <Plus size={16} />
                        Create
                    </button>
                </div>
            </header>

            {/* Board */}
            <main className="flex-1 overflow-x-auto overflow-y-hidden p-6">
                <div className="flex h-full gap-6 min-w-max">
                    {COLUMNS.map(column => {
                        const columnIssues = getIssuesByStatus(column.id);

                        return (
                            <div key={column.id} className={`w-80 flex flex-col rounded-lg ${column.bg} max-h-full`}>
                                {/* Column Header */}
                                <div className="p-3 flex items-center justify-between text-xs font-semibold text-gray-500 uppercase tracking-wider">
                                    <div className="flex items-center gap-2">
                                        <span>{column.title}</span>
                                        <span className="bg-gray-200 text-gray-600 px-1.5 py-0.5 rounded-full text-[10px]">
                                            {columnIssues.length}
                                        </span>
                                    </div>
                                    <div className="flex gap-1">
                                        <button className="hover:bg-gray-200 p-1 rounded"><Plus size={14} /></button>
                                        <button className="hover:bg-gray-200 p-1 rounded"><MoreHorizontal size={14} /></button>
                                    </div>
                                </div>

                                {/* Issues List */}
                                <div className="flex-1 overflow-y-auto p-2 space-y-2">
                                    {isLoading ? (
                                        [...Array(3)].map((_, i) => (
                                            <div key={i} className="bg-white h-24 rounded shadow-sm animate-pulse"></div>
                                        ))
                                    ) : (
                                        columnIssues.map(issue => (
                                            <IssueCard
                                                key={issue.id}
                                                issue={issue}
                                                onClick={handleEditIssue}
                                            />
                                        ))
                                    )}
                                </div>
                            </div>
                        );
                    })}
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

function MoreHorizontal({ size }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <circle cx="12" cy="12" r="1" />
            <circle cx="19" cy="12" r="1" />
            <circle cx="5" cy="12" r="1" />
        </svg>
    );
}
