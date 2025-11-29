import { useState } from 'react';
import { Plus, Search, Filter, Settings, MoreHorizontal } from 'lucide-react';
import { DragDropContext, Droppable, Draggable } from '@hello-pangea/dnd';
import { useIssues, useCreateIssue, useUpdateIssue, useDeleteIssue, useUpdateIssueStatus } from '../hooks/useIssues';
import { IssueCard } from '../components/IssueCard';
import { IssueModal } from '../components/IssueModal';

const COLUMNS = [
    { id: 'OPEN', title: 'To Do', bg: 'bg-slate-900/50' },
    { id: 'IN_PROGRESS', title: 'In Progress', bg: 'bg-blue-900/20' },
    { id: 'RESOLVED', title: 'Done', bg: 'bg-green-900/20' }
];

export const Dashboard = () => {
    const [filters, setFilters] = useState({});
    const [selectedIssue, setSelectedIssue] = useState(null);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [isEditing, setIsEditing] = useState(false);

    const { data: issuesData, isLoading } = useIssues(filters);
    const createMutation = useCreateIssue();
    const updateMutation = useUpdateIssue();
    const updateStatusMutation = useUpdateIssueStatus();
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

    const onDragEnd = async (result) => {
        const { destination, source, draggableId } = result;

        if (!destination) return;

        if (
            destination.droppableId === source.droppableId &&
            destination.index === source.index
        ) {
            return;
        }

        const newStatus = destination.droppableId;
        const issueId = parseInt(draggableId);

        // Optimistic update could be handled here, but for now we'll rely on React Query invalidation
        try {
            await updateStatusMutation.mutateAsync({ id: issueId, status: newStatus });
        } catch (error) {
            console.error('Failed to update status:', error);
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
        <div className="h-screen flex flex-col bg-slate-950 text-slate-200">
            {/* Header */}
            <header className="border-b border-slate-800 px-6 py-3 flex items-center justify-between bg-slate-900">
                <div className="flex items-center gap-4">
                    <div className="w-8 h-8 bg-blue-600 rounded flex items-center justify-center text-white font-bold shadow-lg shadow-blue-900/20">
                        IT
                    </div>
                    <div>
                        <h1 className="text-sm font-semibold text-slate-100">Issue Tracker / Board</h1>
                        <p className="text-xs text-slate-400">Sprint 1</p>
                    </div>
                </div>

                <div className="flex items-center gap-3">
                    <div className="relative">
                        <Search className="absolute left-2.5 top-2 text-slate-400" size={16} />
                        <input
                            type="text"
                            placeholder="Search issues..."
                            className="pl-9 pr-4 py-1.5 bg-slate-800 border-transparent rounded text-sm text-slate-200 focus:bg-slate-700 focus:ring-2 focus:ring-blue-500 transition-all w-64 placeholder-slate-500"
                        />
                    </div>
                    <button className="p-2 text-slate-400 hover:bg-slate-800 rounded hover:text-slate-200 transition-colors">
                        <Filter size={18} />
                    </button>
                    <button className="p-2 text-slate-400 hover:bg-slate-800 rounded hover:text-slate-200 transition-colors">
                        <Settings size={18} />
                    </button>
                    <button
                        onClick={handleCreateIssue}
                        className="flex items-center gap-2 px-3 py-1.5 bg-blue-600 text-white text-sm font-medium rounded hover:bg-blue-500 transition shadow-lg shadow-blue-900/20"
                    >
                        <Plus size={16} />
                        Create
                    </button>
                </div>
            </header>

            {/* Board */}
            <DragDropContext onDragEnd={onDragEnd}>
                <main className="flex-1 overflow-x-auto overflow-y-hidden p-6">
                    <div className="flex h-full gap-6 min-w-max">
                        {COLUMNS.map(column => {
                            const columnIssues = getIssuesByStatus(column.id);

                            return (
                                <Droppable key={column.id} droppableId={column.id}>
                                    {(provided, snapshot) => (
                                        <div
                                            ref={provided.innerRef}
                                            {...provided.droppableProps}
                                            className={`w-80 flex flex-col rounded-lg ${column.bg} max-h-full border border-slate-800/50 transition-colors ${snapshot.isDraggingOver ? 'ring-2 ring-blue-500/50' : ''}`}
                                        >
                                            {/* Column Header */}
                                            <div className="p-3 flex items-center justify-between text-xs font-semibold text-slate-400 uppercase tracking-wider">
                                                <div className="flex items-center gap-2">
                                                    <span>{column.title}</span>
                                                    <span className="bg-slate-800 text-slate-300 px-1.5 py-0.5 rounded-full text-[10px]">
                                                        {columnIssues.length}
                                                    </span>
                                                </div>
                                                <div className="flex gap-1">
                                                    <button className="hover:bg-slate-800 p-1 rounded text-slate-500 hover:text-slate-300"><Plus size={14} /></button>
                                                    <button className="hover:bg-slate-800 p-1 rounded text-slate-500 hover:text-slate-300"><MoreHorizontal size={14} /></button>
                                                </div>
                                            </div>

                                            {/* Issues List */}
                                            <div className="flex-1 overflow-y-auto p-2 space-y-2 min-h-[100px]">
                                                {isLoading ? (
                                                    [...Array(3)].map((_, i) => (
                                                        <div key={i} className="bg-slate-800 h-24 rounded shadow-sm animate-pulse"></div>
                                                    ))
                                                ) : (
                                                    columnIssues.map((issue, index) => (
                                                        <Draggable key={issue.id} draggableId={issue.id.toString()} index={index}>
                                                            {(provided, snapshot) => (
                                                                <div
                                                                    ref={provided.innerRef}
                                                                    {...provided.draggableProps}
                                                                    {...provided.dragHandleProps}
                                                                    style={{
                                                                        ...provided.draggableProps.style,
                                                                        opacity: snapshot.isDragging ? 0.8 : 1,
                                                                    }}
                                                                >
                                                                    <IssueCard
                                                                        issue={issue}
                                                                        onClick={handleEditIssue}
                                                                    />
                                                                </div>
                                                            )}
                                                        </Draggable>
                                                    ))
                                                )}
                                                {provided.placeholder}
                                            </div>
                                        </div>
                                    )}
                                </Droppable>
                            );
                        })}
                    </div>
                </main>
            </DragDropContext>

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
