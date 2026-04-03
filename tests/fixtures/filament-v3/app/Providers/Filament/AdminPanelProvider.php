<?php

namespace App\Providers\Filament;

use App\Filament\Resources\UserResource;
use App\Filament\Resources\PostResource;
use App\Filament\Pages\Dashboard;
use App\Filament\Widgets\StatsOverview;
use App\Filament\Widgets\LatestOrders;
use Filament\Panel;
use Filament\PanelProvider;

class AdminPanelProvider extends PanelProvider
{
    public function panel(Panel $panel): Panel
    {
        return $panel
            ->default()
            ->id('admin')
            ->path('admin')
            ->resources([
                UserResource::class,
                PostResource::class,
            ])
            ->pages([
                Dashboard::class,
            ])
            ->widgets([
                StatsOverview::class,
                LatestOrders::class,
            ]);
    }
}
