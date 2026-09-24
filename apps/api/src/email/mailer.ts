import nodemailer, { type Transporter } from 'nodemailer';
import type { Config } from '../config.js';

export interface MailAttachment { filename: string; content: Buffer; contentType: string }
export interface MailMessage { to: string; subject: string; text: string; attachments?: MailAttachment[] }
export type SendResult = { id: string } | { error: string };

export interface Mailer {
  readonly configured: boolean;
  /** Messages captured by the in-memory JSON transport (`SMTP_URL=json`); always empty for real SMTP. */
  readonly outbox: MailMessage[];
  send(msg: MailMessage): Promise<SendResult>;
  close(): Promise<void>;
}

/**
 * Without SMTP_URL the mailer is an explicit no-op: `send` answers `{ error: 'smtp_not_configured' }`
 * so the caller can record the failure, and nothing ever throws for lack of email (spec §18.5).
 */
export function createMailer(config: Config): Mailer {
  const outbox: MailMessage[] = [];
  if (!config.smtpUrl) {
    return {
      configured: false,
      outbox,
      async send() { return { error: 'smtp_not_configured' }; },
      async close() { /* nothing to close */ },
    };
  }
  const capture = config.smtpUrl === 'json';
  const transport: Transporter = capture
    ? nodemailer.createTransport({ jsonTransport: true })
    : nodemailer.createTransport(config.smtpUrl);
  return {
    configured: true,
    outbox,
    async send(msg: MailMessage): Promise<SendResult> {
      try {
        const info = await transport.sendMail({
          from: config.emailFrom, to: msg.to, subject: msg.subject, text: msg.text,
          ...(msg.attachments ? { attachments: msg.attachments } : {}),
        });
        if (capture) outbox.push(msg);
        return { id: String(info.messageId) };
      } catch (err) {
        return { error: (err instanceof Error ? err.message : 'send_failed').slice(0, 500) };
      }
    },
    async close() { transport.close(); },
  };
}
