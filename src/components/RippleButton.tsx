import type * as React from "react";
import Fab from "@mui/material/Fab";
import FolderOpen from "@mui/icons-material/FolderOpen";

interface IconProps {
    children?: React.ReactNode;
    className: string;
    onClick?: () => void;
}

export const RippleButton = (props: IconProps) => {
    const { children, className = "", ...otherProps } = props;

    return (
        <Fab
            className={`fab ${className}`}
            color="primary"
            aria-label="add"
            {...otherProps}
        >
            <FolderOpen />
            {children}
        </Fab>
    );
};
