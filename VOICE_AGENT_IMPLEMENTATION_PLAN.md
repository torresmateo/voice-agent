# Voice AI Agent Implementation Plan

## Overview

Build a real-time voice AI agent using OpenAI Realtime API with WebSocket transport on Elysia server, integrated with better-auth authentication and Arcade.dev tool calling. All OpenAI API keys remain server-side; no ephemeral tokens sent to client.

## Architecture

```
Client (React)          Server (Elysia)         OpenAI Realtime API
     |                         |                         |
     |-- WebSocket PCM16 ----->|                         |
     |   + session cookie      |-- WebSocket relay ----->|
     |                         |                         |
     |<-- WebSocket PCM16 -----|<-- Audio response ------|
     |                         |                         |
     |                         |-- Tool calls ---------> Arcade.dev
```

**Key Flow:**
1. Client authenticates via existing better-auth (session cookie)
2. Client connects WebSocket to `/voice` endpoint
3. Server validates session cookie, creates voice session record
4. Server establishes WebSocket to OpenAI Realtime API
5. Audio/events relay bidirectionally (client ↔ server ↔ OpenAI)
6. Tool calls execute server-side via Arcade.dev with user context

## Dependencies to Install

**Server (`apps/server/package.json`):**
```bash
bun add @openai/realtime-api-beta @arcadehq/arcade-js ws
```

**Environment Variables:**

Server (`.env` or `packages/env/src/server.ts`):
```
OPENAI_API_KEY=sk-...
ARCADE_API_KEY=arcade_...
```

Web (`packages/env/src/web.ts`):
```
VITE_WS_URL=ws://localhost:3000  # or wss://... for production
```

## File Structure

### Server Files (Create)

```
apps/server/src/voice/
├── voice-handler.ts              # Main WebSocket handler (open/message/close)
├── session-manager.ts            # Database operations for voice sessions
├── openai-realtime-client.ts     # OpenAI Realtime API wrapper
├── arcade-tool-handler.ts        # Arcade.dev integration
├── auth-verifier.ts              # Custom verifier (better-auth cookie → userId)
└── types.ts                      # TypeScript interfaces
```

### Client Files (Create)

```
apps/web/src/
├── routes/voice.tsx              # Voice UI route (connect/record buttons)
├── lib/voice-client.ts           # WebSocket client wrapper
├── lib/audio-processor.ts        # Audio capture (mic) & playback (speaker)
└── lib/voice-types.ts            # Shared types
```

### Database Schema (Create)

```
packages/db/prisma/schema/voice.prisma
```

Add VoiceSession model:
```prisma
model VoiceSession {
  id             String   @id @default(cuid())
  userId         String
  user           User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  sessionToken   String   @unique
  status         String   @default("active")
  conversationId String?
  metadata       Json?
  startedAt      DateTime @default(now())
  endedAt        DateTime?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  @@index([userId])
  @@index([sessionToken])
  @@map("voice_session")
}
```

Update User model in auth schema:
```prisma
voiceSessions VoiceSession[]
```

## Implementation Phases

### Phase 1: Database & Environment Setup

1. Create `packages/db/prisma/schema/voice.prisma`
2. Update User model with `voiceSessions` relation
3. Run `bun run db:generate && bun run db:push`
4. Add environment variables (OPENAI_API_KEY, ARCADE_API_KEY, VITE_WS_URL)
5. Install dependencies

### Phase 2: Authentication Verifier

**File:** `apps/server/src/voice/auth-verifier.ts`

- Extract better-auth session cookie from WebSocket headers
- Validate with better-auth API
- Return `{ userId, sessionToken }` or null

**Key Pattern:**
```typescript
const cookie = ws.request.headers.get("cookie");
const session = await auth.api.getSession({ headers: { cookie } });
return session?.user?.id ? { userId: session.user.id, sessionToken } : null;
```

### Phase 3: Session Manager

**File:** `apps/server/src/voice/session-manager.ts`

CRUD operations for VoiceSession model:
- `createSession(userId)` - Create new voice session
- `getSession(sessionToken)` - Retrieve session
- `endSession(sessionToken)` - Mark session as ended

### Phase 4: Arcade Tool Handler

**File:** `apps/server/src/voice/arcade-tool-handler.ts`

- Initialize Arcade client with API key
- `getToolDefinitions()` - Fetch available tools, convert to OpenAI function format
- `executeTool(name, args)` - Execute tool with user context

**Important:** Pass `user_id` to Arcade for permission-aware execution

### Phase 5: OpenAI Realtime Client

**File:** `apps/server/src/voice/openai-realtime-client.ts`

Wrapper for OpenAI Realtime API:
- `connect()` - Establish WebSocket, configure session (voice: "alloy", format: "pcm16", VAD: server)
- `registerTools()` - Update session with Arcade tool definitions
- `sendAudio(buffer)` - Forward client audio to OpenAI
- `onAudioDelta(callback)` - Emit audio chunks to client
- `onToolCall(callback)` - Handle function calls, execute via Arcade, send result back
- `disconnect()` - Cleanup connection

### Phase 6: Main Voice Handler

**File:** `apps/server/src/voice/voice-handler.ts`

Main orchestrator with WebSocket lifecycle hooks:

**`open(ws)`:**
1. Verify auth with `VoiceAuthVerifier`
2. Create voice session in DB
3. Initialize `ArcadeToolHandler` and `OpenAIRealtimeClient`
4. Connect to OpenAI Realtime API
5. Setup event forwarding (OpenAI audio → client WS)
6. Setup tool call handling (OpenAI → Arcade → OpenAI)
7. Store connection state in Map
8. Send `{ type: "ready" }` to client

**`message(ws, msg)`:**
- Binary (ArrayBuffer): Forward to OpenAI as audio
- JSON: Handle control messages (stop, etc.)

**`close(ws)`:**
1. Disconnect OpenAI client
2. End voice session in DB
3. Remove from connections Map

**`error(ws, err)`:**
- Log error, cleanup connection

### Phase 7: Add WebSocket Route to Server

**File:** `apps/server/src/index.ts`

Add before `.listen()`:
```typescript
import { voiceHandler } from "./voice/voice-handler";

// ...existing routes...
.ws("/voice", {
  open: voiceHandler.open,
  message: voiceHandler.message,
  close: voiceHandler.close,
  error: voiceHandler.error,
})
```

### Phase 8: Client Audio Processor

**File:** `apps/web/src/lib/audio-processor.ts`

Handle browser audio I/O:
- `startCapture(onAudio)` - Request mic, capture PCM16 at 24kHz, call onAudio callback
- `stopCapture()` - Stop mic access
- `playAudio(pcm16)` - Play received audio through speakers
- `floatTo16BitPCM()` - Convert Float32Array to Int16Array

**Key:** Use `ScriptProcessorNode` or `AudioWorklet` for real-time processing

### Phase 9: Client Voice Client

**File:** `apps/web/src/lib/voice-client.ts`

WebSocket wrapper:
- `connect()` - Establish WS connection (cookie auto-sent)
- `sendAudio(pcm16)` - Send binary audio to server
- `onAudio(callback)` - Handle incoming binary audio
- `onStatus(callback)` - Handle JSON messages (ready, error, etc.)
- `disconnect()` - Close WS

### Phase 10: Voice UI Route

**File:** `apps/web/src/routes/voice.tsx`

React component with:
- Auth guard (redirect to /login if not authenticated)
- Connect/Disconnect buttons
- Start/Stop Recording buttons
- Status display
- Visual recording indicator

**Flow:**
1. User clicks "Connect" → VoiceClient.connect()
2. On ready → Enable "Start Recording"
3. User clicks "Start Recording" → AudioProcessor.startCapture() → pipe to VoiceClient
4. AI responds → VoiceClient.onAudio() → AudioProcessor.playAudio()

## Critical Files to Modify

1. **apps/server/src/index.ts** - Add `.ws("/voice", voiceHandler)` route
2. **packages/db/prisma/schema/voice.prisma** - Add VoiceSession model (NEW)
3. **packages/db/prisma/schema/auth.prisma** - Add voiceSessions relation to User
4. **packages/env/src/server.ts** - Add OPENAI_API_KEY, ARCADE_API_KEY
5. **packages/env/src/web.ts** - Add VITE_WS_URL

## Critical Files to Create

1. **apps/server/src/voice/voice-handler.ts** - Main orchestration
2. **apps/server/src/voice/auth-verifier.ts** - Custom user verifier
3. **apps/server/src/voice/session-manager.ts** - DB operations
4. **apps/server/src/voice/openai-realtime-client.ts** - OpenAI integration
5. **apps/server/src/voice/arcade-tool-handler.ts** - Arcade.dev integration
6. **apps/server/src/voice/types.ts** - Shared types
7. **apps/web/src/routes/voice.tsx** - Voice UI
8. **apps/web/src/lib/voice-client.ts** - WebSocket client
9. **apps/web/src/lib/audio-processor.ts** - Audio I/O

## Security Considerations

✅ **Server-side API keys** - OpenAI & Arcade keys never exposed to client
✅ **Cookie-based auth** - Existing better-auth session cookies (httpOnly, secure, sameSite=none)
✅ **User-scoped sessions** - Voice sessions linked to authenticated users in DB
✅ **Permission-aware tools** - Arcade.dev receives user_id for authorization
✅ **No ephemeral tokens** - Client never gets OpenAI API key or temporary tokens

## Verification Steps

### After Implementation:

1. **Database:** Run `bun run db:studio` → verify VoiceSession table exists
2. **Server:** Run `bun run dev:server` → check WebSocket route registered
3. **Auth Test:**
   - Login to web app
   - Navigate to /voice route
   - Verify connection succeeds (should see "ready" status)
4. **Audio Test:**
   - Click "Start Recording"
   - Speak into microphone
   - Verify AI responds with audio
5. **Tool Test:**
   - Configure Arcade.dev tools
   - Trigger tool call via voice command
   - Verify tool executes and result spoken back
6. **Session Test:**
   - Check database for created VoiceSession records
   - Verify sessions properly end on disconnect

### Dev Tools:

- Browser DevTools → Network → WS tab (inspect messages)
- Prisma Studio → VoiceSession table (verify session creation)
- Server console logs (OpenAI events, tool calls)

## Extension Ideas (Future)

- Conversation history persistence
- Transcript display in real-time
- Voice activity detection UI feedback
- Multi-modal responses (text + audio)
- Conversation analytics dashboard
- Export/share conversations

## Notes

- **Elysia WebSockets:** Native support via `.ws()` - no plugins needed
- **Audio Format:** PCM16 at 24kHz (OpenAI Realtime standard)
- **Bun Runtime:** Full support for WebSockets, excellent performance
- **Better Auth Integration:** Seamless - session cookies work automatically with WebSocket upgrade requests
- **Arcade.dev:** Direct client usage (not MCP gateway as specified)
