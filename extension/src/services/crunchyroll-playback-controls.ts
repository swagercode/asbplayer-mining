/** Keep native controls available on pause without flashing them for subtitle seeks. */
export class CrunchyrollPlaybackControls {
    private readonly style = document.createElement('style');

    constructor(private readonly root: Element) {
        // These are the native player's explicit control wrappers. Do not hide the
        // full player overlay: it also contains buffering, errors and mining UI.
        const controls = ':is([data-testid="top-controls-autohide"], [data-testid="bottom-controls-autohide"])';
        this.style.textContent = `
            [data-asbplayer-playback-controls] ${controls} { transition: none !important; }
            [data-asbplayer-playback-controls="playing"] ${controls},
            [data-asbplayer-playback-controls="playing"] [data-testid="top-gradient-background"],
            [data-asbplayer-playback-controls="playing"] [data-testid="menu-background"] {
                visibility: hidden !important;
                opacity: 0 !important;
                pointer-events: none !important;
            }
            [data-asbplayer-playback-controls="paused"] ${controls} {
                visibility: visible !important;
                opacity: 1 !important;
                pointer-events: auto !important;
            }
        `;
        root.append(this.style);
    }

    update(playing: boolean) {
        this.root.setAttribute('data-asbplayer-playback-controls', playing ? 'playing' : 'paused');
    }

    dispose() {
        this.style.remove();
        this.root.removeAttribute('data-asbplayer-playback-controls');
    }
}
