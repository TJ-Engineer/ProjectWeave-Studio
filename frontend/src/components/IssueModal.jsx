import { useState, useEffect } from 'react';
import { X, Type, CheckSquare, Bookmark, AlertCircle, ChevronDown, Bold, Italic, Underline, Link as LinkIcon, List, Image as ImageIcon } from 'lucide-react';

const ISSUE_TYPES = [
    { id: 'Story', label: 'Story', icon: Bookmark, color: 'text-green-600', bg: 'bg-green-100' },
    { id: 'Task', label: 'Task', icon: CheckSquare, color: 'text-blue-600', bg: 'bg-blue-100' },
    { id: 'Bug', label: 'Bug', icon: AlertCircle, color: 'text-red-600', bg: 'bg-red-100' },
    { id: 'Epic', label: 'Epic', icon: Type, color: 'text-purple-600', bg: 'bg-purple-100' }
];

const PRIORITIES = [
    { id: 'LOW', label: 'Low', color: 'text-gray-600' },
    { id: 'MEDIUM', label: 'Medium', color: 'text-blue-600' },
    { id: 'HIGH', label: 'High', color: 'text-orange-600' },
    { id: 'CRITICAL', label: 'Critical', color: 'text-red-600' }
];

export const IssueModal = ({ issue, onClose, onSave, isLoading }) => {
    const [formData, setFormData] = useState({
        title: '',
        description: '',
        priority: 'MEDIUM',
        status: 'OPEN',
        assigned_to: '',
        project: 'VectorIQ',
        tags: '',
        issue_type: 'Task'
    });

    useEffect(() => {
        if (issue) {
            setFormData({
                title: issue.title || '',
                description: issue.description || '',
                priority: issue.priority || 'MEDIUM',
                status: issue.status || 'OPEN',
                assigned_to: issue.assigned_to || '',
                project: issue.project || 'VectorIQ',
                tags: issue.tags ? issue.tags.join(', ') : '',
                issue_type: issue.issue_type || 'Task'
            });
        }
    }, [issue]);

    const handleSubmit = (e) => {
        e.preventDefault();
        const data = {
            ...formData,
            tags: formData.tags.split(',').map(t => t.trim()).filter(Boolean),
        };
        onSave(data);
    };

    const handleChange = (e) => {
        setFormData({
            ...formData,
            [e.target.name]: e.target.value,
        });
    };

    const selectedType = ISSUE_TYPES.find(t => t.id === formData.issue_type) || ISSUE_TYPES[1];

    return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50 backdrop-blur-sm">
            <div className="bg-white rounded-lg shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col">
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
                    <h2 className="text-xl font-medium text-gray-900">
                        {issue ? `Edit ${formData.issue_type}` : 'Create issue'}
                    </h2>
                    <div className="flex items-center gap-2">
                        <button className="px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded">
                            Import issues
                        </button>
                        <button
                            onClick={onClose}
                            className="text-gray-400 hover:text-gray-600 p-1 rounded-full hover:bg-gray-100 transition"
                        >
                            <X size={20} />
                        </button>
                    </div>
                </div>

                {/* Scrollable Content */}
                <div className="flex-1 overflow-y-auto p-8">
                    <form id="issue-form" onSubmit={handleSubmit} className="space-y-6">

                        {/* Project Field */}
                        <div className="space-y-1.5">
                            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider">
                                Project <span className="text-red-500">*</span>
                            </label>
                            <div className="relative">
                                <select
                                    name="project"
                                    value={formData.project}
                                    onChange={handleChange}
                                    className="w-full pl-3 pr-10 py-2 bg-gray-50 border border-gray-300 rounded hover:bg-gray-100 focus:ring-2 focus:ring-blue-500 focus:border-transparent appearance-none cursor-pointer transition-colors"
                                >
                                    <option value="VectorIQ">VectorIQ (VIQ)</option>
                                    <option value="IssueTracker">Issue Tracker (IT)</option>
                                </select>
                                <ChevronDown className="absolute right-3 top-2.5 text-gray-500 pointer-events-none" size={16} />
                            </div>
                        </div>

                        {/* Issue Type Field */}
                        <div className="space-y-1.5">
                            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider">
                                Issue Type <span className="text-red-500">*</span>
                            </label>
                            <div className="relative">
                                <div className="absolute left-3 top-2.5 pointer-events-none">
                                    <selectedType.icon size={16} className={selectedType.color} />
                                </div>
                                <select
                                    name="issue_type"
                                    value={formData.issue_type}
                                    onChange={handleChange}
                                    className="w-full pl-10 pr-10 py-2 bg-gray-50 border border-gray-300 rounded hover:bg-gray-100 focus:ring-2 focus:ring-blue-500 focus:border-transparent appearance-none cursor-pointer transition-colors"
                                >
                                    {ISSUE_TYPES.map(type => (
                                        <option key={type.id} value={type.id}>
                                            {type.label}
                                        </option>
                                    ))}
                                </select>
                                <ChevronDown className="absolute right-3 top-2.5 text-gray-500 pointer-events-none" size={16} />
                            </div>
                            <p className="text-xs text-gray-500 mt-1">
                                Start typing to get a list of possible matches or press down to select.
                            </p>
                        </div>

                        <hr className="border-gray-200" />

                        {/* Summary Field */}
                        <div className="space-y-1.5">
                            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider">
                                Summary <span className="text-red-500">*</span>
                            </label>
                            <input
                                type="text"
                                name="title"
                                value={formData.title}
                                onChange={handleChange}
                                required
                                className="w-full px-3 py-2 border border-gray-300 rounded focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-shadow"
                                placeholder="What needs to be done?"
                            />
                        </div>

                        {/* Description Field with Fake Toolbar */}
                        <div className="space-y-1.5">
                            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider">
                                Description
                            </label>
                            <div className="border border-gray-300 rounded focus-within:ring-2 focus-within:ring-blue-500 focus-within:border-transparent transition-shadow">
                                {/* Toolbar */}
                                <div className="flex items-center gap-1 p-2 border-b border-gray-200 bg-gray-50 rounded-t">
                                    <button type="button" className="p-1 hover:bg-gray-200 rounded text-gray-600"><Bold size={16} /></button>
                                    <button type="button" className="p-1 hover:bg-gray-200 rounded text-gray-600"><Italic size={16} /></button>
                                    <button type="button" className="p-1 hover:bg-gray-200 rounded text-gray-600"><Underline size={16} /></button>
                                    <div className="w-px h-4 bg-gray-300 mx-1"></div>
                                    <button type="button" className="p-1 hover:bg-gray-200 rounded text-gray-600"><List size={16} /></button>
                                    <button type="button" className="p-1 hover:bg-gray-200 rounded text-gray-600"><LinkIcon size={16} /></button>
                                    <button type="button" className="p-1 hover:bg-gray-200 rounded text-gray-600"><ImageIcon size={16} /></button>
                                </div>
                                <textarea
                                    name="description"
                                    value={formData.description}
                                    onChange={handleChange}
                                    rows={6}
                                    className="w-full px-3 py-2 border-none focus:ring-0 rounded-b resize-y min-h-[120px]"
                                    placeholder="Describe the issue in detail..."
                                />
                            </div>
                        </div>

                        {/* Priority & Assignee Row */}
                        <div className="grid grid-cols-2 gap-6">
                            <div className="space-y-1.5">
                                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider">
                                    Priority
                                </label>
                                <div className="relative">
                                    <select
                                        name="priority"
                                        value={formData.priority}
                                        onChange={handleChange}
                                        className="w-full pl-3 pr-10 py-2 bg-gray-50 border border-gray-300 rounded hover:bg-gray-100 focus:ring-2 focus:ring-blue-500 focus:border-transparent appearance-none cursor-pointer"
                                    >
                                        {PRIORITIES.map(p => (
                                            <option key={p.id} value={p.id}>{p.label}</option>
                                        ))}
                                    </select>
                                    <ChevronDown className="absolute right-3 top-2.5 text-gray-500 pointer-events-none" size={16} />
                                </div>
                            </div>

                            <div className="space-y-1.5">
                                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider">
                                    Assignee
                                </label>
                                <div className="relative">
                                    <input
                                        type="text"
                                        name="assigned_to"
                                        value={formData.assigned_to}
                                        onChange={handleChange}
                                        className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                                        placeholder="Unassigned"
                                    />
                                    <div className="absolute left-3 top-2.5 w-4 h-4 rounded-full bg-gray-300 flex items-center justify-center text-[10px] font-bold text-gray-600">
                                        {formData.assigned_to ? formData.assigned_to[0].toUpperCase() : '?'}
                                    </div>
                                </div>
                                <button type="button" className="text-xs text-blue-600 hover:underline font-medium px-1" onClick={() => setFormData({ ...formData, assigned_to: 'Me' })}>
                                    Assign to me
                                </button>
                            </div>
                        </div>

                        {/* Tags */}
                        <div className="space-y-1.5">
                            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider">
                                Labels
                            </label>
                            <input
                                type="text"
                                name="tags"
                                value={formData.tags}
                                onChange={handleChange}
                                className="w-full px-3 py-2 border border-gray-300 rounded focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                                placeholder="Begin typing to find and create labels..."
                            />
                        </div>

                    </form>
                </div>

                {/* Footer */}
                <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 bg-gray-50 rounded-b-lg">
                    <div className="mr-auto flex items-center gap-2">
                        <input type="checkbox" id="create-another" className="rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
                        <label htmlFor="create-another" className="text-sm text-gray-700">Create another</label>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className="px-4 py-2 text-gray-700 font-medium hover:bg-gray-200 rounded transition"
                    >
                        Cancel
                    </button>
                    <button
                        type="submit"
                        form="issue-form"
                        disabled={isLoading}
                        className="px-4 py-2 text-white bg-blue-600 font-medium rounded hover:bg-blue-700 transition disabled:opacity-50 shadow-sm"
                    >
                        {isLoading ? 'Saving...' : issue ? 'Update' : 'Create'}
                    </button>
                </div>
            </div>
        </div>
    );
};
