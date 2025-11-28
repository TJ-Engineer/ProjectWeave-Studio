export const StatusBadge = ({ status }) => {
    const statusConfig = {
        OPEN: {
            bg: 'bg-blue-100',
            text: 'text-blue-800',
            label: 'Open',
        },
        IN_PROGRESS: {
            bg: 'bg-yellow-100',
            text: 'text-yellow-800',
            label: 'In Progress',
        },
        RESOLVED: {
            bg: 'bg-green-100',
            text: 'text-green-800',
            label: 'Resolved',
        },
        CLOSED: {
            bg: 'bg-gray-100',
            text: 'text-gray-800',
            label: 'Closed',
        },
    };

    const config = statusConfig[status] || statusConfig.OPEN;

    return (
        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${config.bg} ${config.text}`}>
            {config.label}
        </span>
    );
};

export const PriorityBadge = ({ priority }) => {
    const priorityConfig = {
        CRITICAL: {
            bg: 'bg-red-100',
            text: 'text-red-800',
            icon: '🔴',
            label: 'Critical',
        },
        HIGH: {
            bg: 'bg-orange-100',
            text: 'text-orange-800',
            icon: '🟠',
            label: 'High',
        },
        MEDIUM: {
            bg: 'bg-blue-100',
            text: 'text-blue-800',
            icon: '🔵',
            label: 'Medium',
        },
        LOW: {
            bg: 'bg-gray-100',
            text: 'text-gray-800',
            icon: '⚪',
            label: 'Low',
        },
    };

    const config = priorityConfig[priority] || priorityConfig.MEDIUM;

    return (
        <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium ${config.bg} ${config.text}`}>
            <span>{config.icon}</span>
            {config.label}
        </span>
    );
};
