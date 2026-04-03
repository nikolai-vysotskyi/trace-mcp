<?php

namespace App\Listeners;

use App\Events\UserCreated;

class SendUserNotification
{
    public function handle(UserCreated $event): void
    {
        // Send notification
    }
}
