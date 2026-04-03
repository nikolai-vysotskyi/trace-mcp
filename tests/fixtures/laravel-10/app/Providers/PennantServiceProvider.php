<?php

namespace App\Providers;

use Illuminate\Support\ServiceProvider;
use Laravel\Pennant\Feature;

class PennantServiceProvider extends ServiceProvider
{
    public function boot(): void
    {
        Feature::define('new-dashboard', function (User $user) {
            return $user->isAdmin();
        });

        Feature::define('beta-checkout', function (User $user) {
            return in_array($user->email, $this->betaUsers());
        });

        Feature::define('dark-mode', fn (User $user) => $user->prefers_dark);

        Feature::define('maintenance-mode', false);
    }
}
