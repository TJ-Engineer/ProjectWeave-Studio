import { useStats } from '../hooks/useIssues';
import { TrendingUp, AlertCircle, CheckCircle, XCircle } from 'lucide-react';

export const StatsPanel = () => {
    const { data: stats, isLoading } = useStats();

    if (isLoading) {
        return (
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                {[...Array(4)].map((_, i) => (
                    <div key={i} className="bg-white rounded-lg shadow p-6 animate-pulse">
                        <div className="h-4 bg-gray-200 rounded w-1/2 mb-2"></div>
                        <div className="h-8 bg-gray-200 rounded w-1/3"></div>
                    </div>
                ))}
            </div>
        );
    }

    const statCards = [
        {
            label: 'Total Issues',
            value: stats?.total || 0,
            icon: TrendingUp,
            color: 'text-blue-600',
            bg: 'bg-blue-50',
        },
        {
            label: 'Open',
            value: stats?.by_status?.OPEN || 0,
            icon: AlertCircle,
            color: 'text-blue-600',
            bg: 'bg-blue-50',
        },
        {
            label: 'In Progress',
            value: stats?.by_status?.IN_PROGRESS || 0,
            icon: TrendingUp,
            color: 'text-yellow-600',
            bg: 'bg-yellow-50',
        },
        {
            label: 'Resolved',
            value: stats?.by_status?.RESOLVED || 0,
            icon: CheckCircle,
            color: 'text-green-600',
            bg: 'bg-green-50',
        },
    ];

    return (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            {statCards.map((stat, index) => (
                <div key={index} className="bg-white rounded-lg shadow p-6">
                    <div className="flex items-center justify-between">
                        <div>
                            <p className="text-sm font-medium text-gray-600">{stat.label}</p>
                            <p className="text-3xl font-bold text-gray-900 mt-1">{stat.value}</p>
                        </div>
                        <div className={`p-3 rounded-full ${stat.bg}`}>
                            <stat.icon className={stat.color} size={24} />
                        </div>
                    </div>
                </div>
            ))}
        </div>
    );
};
