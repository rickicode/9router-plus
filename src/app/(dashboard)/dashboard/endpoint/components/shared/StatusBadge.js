export default function StatusBadge({ status, className = "" }) {
  const variants = {
    running: "bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20",
    stopped: "bg-gray-500/10 text-gray-600 dark:text-gray-400 border-gray-500/20",
    error: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20",
    enabled: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20",
    disabled: "bg-gray-500/10 text-gray-600 dark:text-gray-400 border-gray-500/20",
  };

  const variant = variants[status.toLowerCase()] || variants.stopped;

  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${variant} ${className}`}>
      <span className="w-1.5 h-1.5 rounded-full bg-current" />
      {status}
    </span>
  );
}
