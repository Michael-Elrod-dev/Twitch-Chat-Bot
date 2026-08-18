import { Minus, Square, X } from 'lucide-react';
import { APP_NAME } from '../theme/tokens.js';

/**
 * The window chrome.
 *
 * Real Tauri window controls, not decorations: the Tauri window is built with
 * `decorations: false` so this strip is the only title bar, and the buttons
 * have to actually minimize, maximise and close.
 */

export interface WindowControls {
    minimize: () => void;
    toggleMaximize: () => void;
    close: () => void;
}

export interface TitleBarProps {
    controls: WindowControls;
}

export function TitleBar({ controls }: TitleBarProps): React.JSX.Element {
    return (
        <header className="titlebar">
            <div className="titlebar__brand">
                <span className="titlebar__mark" aria-hidden="true" />
                <span className="titlebar__wordmark">{APP_NAME}</span>
            </div>

            <div className="titlebar__controls">
                <button
                    type="button"
                    className="titlebar__button"
                    aria-label="Minimize"
                    onClick={controls.minimize}
                >
                    <Minus size={11} />
                </button>
                <button
                    type="button"
                    className="titlebar__button"
                    aria-label="Maximize"
                    onClick={controls.toggleMaximize}
                >
                    <Square size={11} />
                </button>
                <button
                    type="button"
                    className="titlebar__button"
                    aria-label="Close"
                    onClick={controls.close}
                >
                    <X size={11} />
                </button>
            </div>
        </header>
    );
}
