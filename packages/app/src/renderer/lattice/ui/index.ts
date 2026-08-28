/* Lattice UI primitives — the shared component layer.

   Thin wrappers over the canonical island.css classes so there is ONE source
   of truth per primitive. Ported from the trace-mcp-app (Codechats) design
   system: Button, SegmentedControl, Badge, StatusDot, IslandHeader/MiniButton,
   EmptyState, Menu/… — the island-surface (.ws-stage) primitives only. The
   native-window (.dlg) primitives (DlgButton etc.) were intentionally left
   out — this app has no standalone OS-window dialogs to theme with them. */

export { Button } from './Button';
export type { ButtonProps, ButtonSize, ButtonVariant } from './Button';

export { SegmentedControl } from './SegmentedControl';
export type { SegmentedControlProps, SegmentedOption } from './SegmentedControl';

export { SearchField } from './SearchField';
export type { SearchFieldProps } from './SearchField';

export { Chip, ChipGroup } from './Chip';
export type { ChipProps, ChipGroupProps } from './Chip';

export { Checkbox } from './Checkbox';
export type { CheckboxProps } from './Checkbox';

export { PopUpButton } from './PopUpButton';
export type { PopUpButtonProps, PopUpOption } from './PopUpButton';

export { Badge, GradeBadge } from './Badge';
export type { BadgeProps, GradeBadgeProps, Tone } from './Badge';

export { StatusDot } from './StatusDot';
export type { StatusDotProps } from './StatusDot';

export { IslandHeader, MiniButton } from './IslandHeader';
export type { IslandHeaderProps, MiniButtonProps } from './IslandHeader';

export { EmptyState } from './EmptyState';
export type { EmptyStateProps } from './EmptyState';

export { Menu, MenuItem, MenuSection, MenuSeparator, ConfirmPopover } from './Menu';
export type { MenuProps, MenuItemProps, ConfirmPopoverProps } from './Menu';
