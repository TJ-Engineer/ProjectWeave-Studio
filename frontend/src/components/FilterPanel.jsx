import { Filter } from 'lucide-react';

export const FilterPanel = ({ filters, onFilterChange }) => {
    return (
        <div className="bg-white rounded-lg shadow p-4">
            <div className="flex items-center gap-2 mb-4">
                <Filter size={18} className="text-gray-600" />
                <h3 className="font-semibold text-gray-900">Filters</h3>
            </div>

            <div className="space-y-4">
                {/* Status Filter */}
                <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                        Status
                    </label>
                    <select
                        value={filters.status || ''}
                        onChange={(e) => onFilterChange({ ...filters, status: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                    >
                        <option value="">All Statuses</option>
                        <option value="OPEN">Open</option>
                        <option value="IN_PROGRESS">In Progress</option>
                        <option value="RESOLVED">Resolved</option>
                        <option value="CLOSED">Closed</option>
                    </select>
                </div>

                {/* Priority Filter */}
                <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                        Priority
                    </label>
                    <select
                        value={filters.priority || ''}
                        onChange={(e) => onFilterChange({ ...filters, priority: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                    >
                        <option value="">All Priorities</option>
                        <option value="CRITICAL">Critical</option>
                        <option value="HIGH">High</option>
                        <option value="MEDIUM">Medium</option>
                        <option value="LOW">Low</option>
                    </select>
                </div>

                {/* Project Filter */}
                <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                        Project
                    </label>
                    <input
                        type="text"
                        value={filters.project || ''}
                        onChange={(e) => onFilterChange({ ...filters, project: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                        placeholder="Enter project name"
                    />
                </div>

                {/* Clear Filters */}
                {(filters.status || filters.priority || filters.project) && (
                    <button
                        onClick={() => onFilterChange({})}
                        className="w-full px-3 py-2 text-sm text-gray-700 bg-gray-100 rounded-md hover:bg-gray-200 transition"
                    >
                        Clear Filters
                    </button>
                )}
            </div>
        </div>
    );
};
