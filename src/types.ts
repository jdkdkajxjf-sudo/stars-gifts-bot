/** Telegram types used by the gifts bot. */

export interface TgUser {
  id: number
  is_bot: boolean
  first_name: string
  last_name?: string
  username?: string
  language_code?: string
}

export interface TgChat {
  id: number
  type: 'private' | 'group' | 'supergroup' | 'channel'
  title?: string
  username?: string
  first_name?: string
  last_name?: string
}

export interface TgMessage {
  message_id: number
  from?: TgUser
  chat: TgChat
  date: number
  text?: string
  entities?: TgMessageEntity[]
  reply_to_message?: TgMessage
  forward_from?: TgUser
  forward_origin?: {
    type: string
    sender_user?: TgUser
  }
}

export interface TgMessageEntity {
  type: string
  offset: number
  length: number
  url?: string
  user?: TgUser
}

export interface TgCallbackQuery {
  id: string
  from: TgUser
  message?: TgMessage
  data?: string
}

export interface TgUpdate {
  update_id: number
  message?: TgMessage
  edited_message?: TgMessage
  callback_query?: TgCallbackQuery
}
