import { Clock, User, CheckSquare, Bookmark, AlertCircle, Type, MoreHorizontal } from 'lucide-react';

const ISSUE_ICONS = {
    Story: { icon: Bookmark, color: 'text-green-600', bg: 'bg-green-100' },
    Task: { icon: CheckSquare, color: 'text-blue-600', bg: 'bg-blue-100' },
    Bug: { icon: AlertCircle, color: 'text-red-600', bg: 'bg-red-100' },
    Epic: { icon: Type, color: 'text-purple-600', bg: 'bg-purple-100' }
};

const PRIORITY_ICONS = {
    LOW: { icon: '⬇', color: 'text-gray-400' },
    MEDIUM: { icon: '=', color: 'text-blue-400' },
    HIGH: { icon: '⬆', color: 'text-orange-400' },
    CRITICAL: { icon: '⚡', color: 'text-red-500' }
};

export const IssueCard = ({ issue, onClick }) => {
    const formatDate = (dateString) => {
        return new Date(dateString).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
        });
    };

    const TypeIcon = ISSUE_ICONS[issue.issue_type]?.icon || CheckSquare;
    const typeColor = ISSUE_ICONS[issue.issue_type]?.color || 'text-blue-600';
    const PriorityIcon = PRIORITY_ICONS[issue.priority]?.icon || '=';
    const priorityColor = PRIORITY_ICONS[issue.priority]?.color || 'text-blue-400';

    return (
        <div
            onClick={() => onClick(issue)}
            className="bg-white p-3 rounded shadow-sm border border-gray-200 hover:bg-gray-50 cursor-pointer group transition-colors"
        >
            <div className="flex items-start justify-between gap-2 mb-2">
                <p className="text-sm text-gray-900 line-clamp-2 leading-snug font-medium group-hover:text-blue-600 transition-colors">
                    {issue.title}
                </p>
            </div>

            <div className="flex items-center justify-between mt-3">
                <div className="flex items-center gap-2">
                    <div className={`p-0.5 rounded ${ISSUE_ICONS[issue.issue_type]?.bg || 'bg-gray-100'}`}>
                        <TypeIcon size={14} className={typeColor} />
                    </div>
                    <span className={`text-xs font-bold ${priorityColor} w-4 text-center`}>
                        {PriorityIcon}
                    </span>
                    <span className="text-xs text-gray-500 font-mono">
                        {issue.project ? 'VIQ' : 'IT'}-{issue.id}
                    </span>
                </div>

                {issue.assigned_to && (
                    <div
                        className="w-5 h-5 rounded-full bg-gray-200 flex items-center justify-center text-[10px] font-bold text-gray-600 ring-2 ring-white"
                        title={`Assigned to ${issue.assigned_to}`}
                    >
                        {issue.assigned_to[0].toUpperCase()}
                    </div>
                )}
            </div>
        </div>
    );
};
