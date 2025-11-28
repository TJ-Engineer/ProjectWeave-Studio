import { StatusBadge, PriorityBadge } from './Badges';
import { Clock, User } from 'lucide-react';

export const IssueCard = ({ issue, onClick }) => {
    const formatDate = (dateString) => {
        return new Date(dateString).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
        });
    };

    return (
        <div
            onClick={() => onClick(issue)}
            className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 hover:shadow-md transition-shadow cursor-pointer"
        >
            {/* Header */}
            <div className="flex items-start justify-between gap-2 mb-2">
                <h3 className="font-semibold text-gray-900 text-sm flex-1">
                    {issue.title}
                </h3>
                <PriorityBadge priority={issue.priority} />
            </div>

            {/* Description */}
            {issue.description && (
                <p className="text-sm text-gray-600 mb-3 line-clamp-2">
                    {issue.description}
                </p>
            )}

            {/* Tags */}
            {issue.tags && issue.tags.length > 0 && (
                <div className="flex flex-wrap gap-1 mb-3">
                    {issue.tags.map((tag, index) => (
                        <span
                            key={index}
                            className="px-2 py-0.5 bg-gray-100 text-gray-700 text-xs rounded"
                        >
                            {tag}
                        </span>
                    ))}
                </div>
            )}

            {/* Footer */}
            <div className="flex items-center justify-between text-xs text-gray-500">
                <div className="flex items-center gap-3">
                    <StatusBadge status={issue.status} />
                    {issue.assigned_to && (
                        <div className="flex items-center gap-1">
                            <User size={12} />
                            <span>{issue.assigned_to}</span>
                        </div>
                    )}
                </div>
                <div className="flex items-center gap-1">
                    <Clock size={12} />
                    <span>{formatDate(issue.created_at)}</span>
                </div>
            </div>
        </div>
    );
};
