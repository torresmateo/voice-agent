export interface VoiceSessionData {
	userId: string;
	sessionToken: string;
}

export interface ConnectionState {
	userId: string;
	sessionToken: string;
	// biome-ignore lint/suspicious/noExplicitAny: Will be properly typed when OpenAI client is implemented
	openAIClient: any;
	// biome-ignore lint/suspicious/noExplicitAny: Will be properly typed when Arcade handler is implemented
	arcadeHandler: any;
}
