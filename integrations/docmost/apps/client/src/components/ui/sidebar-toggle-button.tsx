import React from "react";
import { IconBook } from "@tabler/icons-react";
import { ActionIcon, BoxProps, ElementProps, MantineColor, MantineSize } from "@mantine/core";

export interface SidebarToggleProps extends BoxProps, ElementProps<"button"> {
  size?: MantineSize | `compact-${MantineSize}` | (string & {});
  color?: MantineColor;
  opened?: boolean;
}

const SidebarToggle = React.forwardRef<HTMLButtonElement, SidebarToggleProps>(
  ({ opened, size = "sm", ...others }, ref) => {
    return (
      <ActionIcon
        size={size}
        aria-expanded={opened}
        {...others}
        variant="subtle"
        color="gray"
        ref={ref}
      >
        <IconBook size={20} stroke={1.75} />
      </ActionIcon>
    );
  }
);

export default SidebarToggle;
