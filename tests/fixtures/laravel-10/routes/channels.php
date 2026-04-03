<?php

use App\Broadcasting\OrderChannel;
use Illuminate\Support\Facades\Broadcast;

Broadcast::channel('orders.{userId}', function ($user, $userId) {
    return $user->id === (int) $userId;
});

Broadcast::channel('presence-chat.{roomId}', function ($user, $roomId) {
    return ['id' => $user->id, 'name' => $user->name];
});

Broadcast::channel('admin', OrderChannel::class);
