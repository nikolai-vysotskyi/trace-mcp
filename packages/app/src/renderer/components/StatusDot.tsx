interface StatusDotProps {
  status: 'active' | 'idle' | 'error' | 'disconnected';
  size?: number;
}

const COLORS: Record<StatusDotProps['status'], string> = {
  active: '#34c759',
  idle: '#ffcc00',
  error: '#ff3b30',
  disconnected: '#8e8e93',
};

export function StatusDot({ status, size = 8 }: StatusDotProps) {
  return (
    <span
      className="inline-block rounded-full shrink-0"
      style={{
        width: size,
        height: size,
        backgroundColor: COLORS[status],
        boxShadow: status === 'active' ? `0 0 4px ${COLORS[status]}` : undefined,
      }}
      title={status}
    />
  );
}
