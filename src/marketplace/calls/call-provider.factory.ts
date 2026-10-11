import { CallProvider } from './call-provider';
import { LiveKitCallProvider } from './livekit-provider';
import { MockCallProvider } from './mock-provider';

/** CALL_PROVIDER=mock|livekit (standart: mock). Production'da mock taqiqlangan. */
export function createCallProvider(env: NodeJS.ProcessEnv = process.env): CallProvider {
  const kind = (env.CALL_PROVIDER || 'mock').toLowerCase();
  if (kind === 'livekit') {
    const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_HTTP_URL } = env;
    if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
      throw new Error('CALL_PROVIDER=livekit requires LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET');
    }
    return new LiveKitCallProvider(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_HTTP_URL || undefined);
  }
  if (kind !== 'mock') throw new Error(`Unknown CALL_PROVIDER "${kind}"`);
  if (env.NODE_ENV === 'production') throw new Error('The mock call provider must not be used in production');
  return new MockCallProvider(env.MOCK_CALL_SECRET || undefined);
}
