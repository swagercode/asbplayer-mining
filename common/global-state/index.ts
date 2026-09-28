// The app and extension currently share settings via extension storage.
// However, each setting can have different values per profile.
// "Global state" exists for other kinds of key/value pairs that should
// not be affected by settings profiles. For example: FTUE state.

export enum AnnotationTutorialState {
    hasNotSeen = 0,
    shouldSee = 1,
    hasSeen = 2,
}

export interface JimakuCachedWork {
    id: number;
    name: string;
}

export interface OnlineSubtitleSourceConfig {
    jimakuApiKey: string;
    jimakuSearchCategory: 'anime' | 'drama';
    jimakuRecentWorks?: JimakuCachedWork[];
    // Automatically pick and load a Jimaku subtitle for the current episode on supported
    // streaming sites (currently Crunchyroll), using the local ChatGPT account to choose the file
    jimakuAutoSelect?: boolean;
}

export type GenericParseType = 'off' | 'base' | 'aggressive';

export interface GenericSubtitleParserState {
    pages: {
        [host: string]: {
            parse: GenericParseType;
        };
    };
}

export const initialGlobalState: GlobalState = {
    ftueHasSeenAnkiDialogQuickSelectV2: false,
    ftueHasSeenSubtitleTrackSelector: false,
    ftueAnnotation: AnnotationTutorialState.hasNotSeen,
    genericSubtitleParser: {
        pages: {},
    },
    onlineSubtitleSourceConfig: {
        jimakuApiKey: '',
        jimakuSearchCategory: 'anime',
        jimakuRecentWorks: [],
        jimakuAutoSelect: false,
    },
};

export interface GlobalState {
    ftueHasSeenAnkiDialogQuickSelectV2: boolean;
    ftueHasSeenSubtitleTrackSelector: boolean;
    ftueAnnotation: AnnotationTutorialState;
    genericSubtitleParser: GenericSubtitleParserState;
    onlineSubtitleSourceConfig: OnlineSubtitleSourceConfig;
}

export interface GlobalStateProvider {
    getAll: () => Promise<GlobalState>;
    get: <K extends keyof GlobalState>(keys: K[]) => Promise<Pick<GlobalState, K>>;
    set: (state: Partial<GlobalState>) => Promise<void>;
}
