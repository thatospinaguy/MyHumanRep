import { createApp } from './app';
import { loadConfig } from './config';
import type { Env } from './env';
import { createMailer, processOutbox } from './services/notifications';
import { purgeExpiredCounters, runRetention } from './services/retention';

const app = createApp();

export default {
  fetch: app.fetch,

  /** Cron: "*\/5 * * * *" drains the notification outbox; "0 4 * * *" runs retention. */
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const config = loadConfig(env);
    const now = new Date(controller.scheduledTime);
    if (controller.cron === '0 4 * * *') {
      const result = await runRetention(env.MHR_DB, config, now);
      console.log(JSON.stringify({ level: 'info', event: 'retention_run', ...result }));
      return;
    }
    const result = await processOutbox(env.MHR_DB, config, createMailer(env, config), now, 50);
    console.log(JSON.stringify({ level: 'info', event: 'outbox_drain', ...result }));
    ctx.waitUntil(purgeExpiredCounters(env.MHR_DB, now));
  },
} satisfies ExportedHandler<Env>;
