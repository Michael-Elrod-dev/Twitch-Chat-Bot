import { CloudOff, X } from 'lucide-react';

/**
 * The banner half of the one error presentation.
 *
 * Reuses the dashboard's `.banner` styling rather than inventing a second look:
 * "we could not reach the server" should say the same thing in the same voice
 * wherever the user happens to be standing.
 *
 * Dismissable. Unlike the dashboard banner, which describes an ongoing condition
 * the screen is still in, these describe one request that failed.
 * Leaving it pinned after a successful retry would be stale.
 */

export interface ContentBannerProps {
    message: string;
    onDismiss: () => void;
}

export function ContentBanner({ message, onDismiss }: ContentBannerProps): React.JSX.Element {
    return (
        <div className="banner banner--neutral" role="status">
            <span className="banner__icon">
                <CloudOff size={18} aria-hidden="true" />
            </span>
            <span className="banner__text">
                <span className="banner__title">{message}</span>
            </span>
            <button type="button" className="banner__dismiss" aria-label="Dismiss" onClick={onDismiss}>
                <X size={16} />
            </button>
        </div>
    );
}
