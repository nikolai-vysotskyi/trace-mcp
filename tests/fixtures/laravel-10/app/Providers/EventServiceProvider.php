<?php

namespace App\Providers;

use App\Events\UserCreated;
use App\Listeners\SendUserNotification;
use Illuminate\Foundation\Support\Providers\EventServiceProvider as ServiceProvider;

class EventServiceProvider extends ServiceProvider
{
    protected $listen = [
        UserCreated::class => [
            SendUserNotification::class,
        ],
    ];
}
