import { Clock, User, CheckSquare, Bookmark, AlertCircle, Type, MoreHorizontal } from 'lucide-react';

const ISSUE_ICONS = {
    Story: { icon: Bookmark, color: 'text-green-500', bg: 'bg-green-900/30' },
    Task: { icon: CheckSquare, color: 'text-blue-500', bg: 'bg-blue-900/30' },
    Bug: { icon: AlertCircle, color: 'text-red-500', bg: 'bg-red-900/30' },
    Epic: { icon: Type, color: 'text-purple-500', bg: 'bg-purple-900/30' }
};

const PRIORITY_ICONS = {
    LOW: { icon: '⬇', color: 'text-slate-500' },
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
    const typeColor = ISSUE_ICONS[issue.issue_type]?.color || 'text-blue-500';
    const PriorityIcon = PRIORITY_ICONS[issue.priority]?.icon || '=';
    const priorityColor = PRIORITY_ICONS[issue.priority]?.color || 'text-blue-400';

    return (
        <div
            onClick={() => onClick(issue)}
            className="bg-slate-800 p-3 rounded shadow-sm border border-slate-700 hover:bg-slate-700 cursor-pointer group transition-colors"
        >
            <div className="flex items-start justify-between gap-2 mb-2">
                <p className="text-sm text-slate-200 line-clamp-2 leading-snug font-medium group-hover:text-blue-400 transition-colors">
                    {issue.title}
                </p>
            </div>

            <div className="flex items-center justify-between mt-3">
                <div className="flex items-center gap-2">
                    <div className={`p-0.5 rounded ${ISSUE_ICONS[issue.issue_type]?.bg || 'bg-slate-700'}`}>
                        <TypeIcon size={14} className={typeColor} />
                    </div>
                    <span className={`text-xs font-bold ${priorityColor} w-4 text-center`}>
                        {PriorityIcon}
                    </span>
                    <span className="text-xs text-slate-500 font-mono">
                        {issue.project === 'VectorIQ' ? 'VIQ' : (issue.project === 'IssueTracker' ? 'IT' : 'PROJ')}-{issue.id}
                    </span>
                </div>

                {issue.assigned_to && (
                    <div
                        className="w-5 h-5 rounded-full bg-slate-600 flex items-center justify-center text-[10px] font-bold text-slate-300 ring-2 ring-slate-800"
                        title={`Assigned to ${issue.assigned_to}`}
                    >
                        {issue.assigned_to[0].toUpperCase()}
                    </div>
                )}
            </div>
        </div>
    );
};
