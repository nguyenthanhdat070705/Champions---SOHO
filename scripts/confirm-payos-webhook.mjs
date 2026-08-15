import { getPayOSClient } from "../server/payos/client.js";
import { getWebhookUrl } from "../server/payos/config.js";

try {
  const webhookUrl = getWebhookUrl();
  const result = await getPayOSClient().webhooks.confirm(webhookUrl);

  console.log(
    JSON.stringify(
      {
        success: true,
        webhookUrl: result.webhookUrl,
        channelName: result.name,
        channelShortName: result.shortName,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

