export const LOCAL_MESSAGE_LIMIT = 100;
export {
  SHARED_CONTEXT_LIMIT,
  isHandoffMessage as isLiteMessage,
  mergeHandoffMessages as mergeMessageHistory,
  newHandoffMessage as newLiteMessage,
  normalizeHandoffMessages as normalizeMessages,
  parseSharedContextRow,
} from '../utils/recentContextHandoff';
