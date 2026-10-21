<?php
// Copy to config.php OUTSIDE the public web root.
return [
 'recipient' => '', // Recipient email
 'from' => '', // Sender on this hosting domain
 'webhook' => '', // https://YOUR.bitrix24.ru/rest/USER/SECRET/
 'state_dir' => __DIR__ . '/private-state',
 'assigned_by_id' => 0,
];
