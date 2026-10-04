/** Fullscreen the entire player so its controls and dictionary popup stay inside it. */
export async function toggleVideoFullscreen(video: HTMLMediaElement) {
    const document = video.ownerDocument;
    if (document.fullscreenElement) {
        await document.exitFullscreen();
    } else {
        const player = video.closest<HTMLElement>('#player-container') ?? video.parentElement ?? video;
        await player.requestFullscreen();
    }
}
