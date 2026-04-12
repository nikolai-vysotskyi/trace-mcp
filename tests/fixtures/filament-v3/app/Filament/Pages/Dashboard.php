<?php

namespace App\Filament\Pages;

use Filament\Pages\Page;

class Dashboard extends Page
{
    protected static ?string $navigationIcon = 'heroicon-o-home';

    protected static ?string $navigationLabel = 'Dashboard';

    protected static ?int $navigationSort = 1;

    protected static string $view = 'filament.pages.dashboard';

    protected function getHeaderWidgets(): array
    {
        return [
            \App\Filament\Widgets\StatsOverview::class,
        ];
    }
}
