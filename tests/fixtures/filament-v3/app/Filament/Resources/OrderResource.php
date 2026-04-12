<?php

namespace App\Filament\Resources;

use App\Models\Order;
use App\Filament\Clusters\Settings;
use Filament\Forms\Form;
use Filament\Forms\Components\TextInput;
use Filament\Forms\Components\DatePicker;
use Filament\Forms\Components\Toggle;
use Filament\Forms\Components\Section;
use Filament\Forms\Components\Tabs;
use Filament\Infolists\Infolist;
use Filament\Infolists\Components\TextEntry;
use Filament\Infolists\Components\IconEntry;
use Filament\Resources\Resource;
use Filament\Tables\Table;
use Filament\Tables\Columns\TextColumn;
use Filament\Tables\Columns\IconColumn;
use Filament\Tables\Columns\ToggleColumn;
use Filament\Tables\Filters\SelectFilter;
use Filament\Tables\Filters\TernaryFilter;
use Filament\Tables\Filters\TrashedFilter;
use Filament\Tables\Actions\EditAction;
use Filament\Tables\Actions\DeleteAction;
use Filament\Tables\Actions\ViewAction;
use Filament\Tables\Actions\DeleteBulkAction;
use Filament\Notifications\Notification;

class OrderResource extends Resource
{
    protected static ?string $model = Order::class;

    protected static ?string $recordTitleAttribute = 'order_number';

    protected static ?string $cluster = Settings::class;

    protected static ?string $navigationGroup = 'Shop';

    protected static ?string $navigationIcon = 'heroicon-o-shopping-cart';

    protected static ?int $navigationSort = 3;

    public static function form(Form $form): Form
    {
        return $form->schema([
            Section::make('Order Details')->schema([
                TextInput::make('order_number')->required(),
                DatePicker::make('ordered_at'),
                Toggle::make('is_shipped'),
            ]),
            Tabs::make('Extra')->tabs([]),
        ]);
    }

    public static function table(Table $table): Table
    {
        return $table
            ->columns([
                TextColumn::make('order_number')->sortable(),
                TextColumn::make('customer.name'),
                IconColumn::make('is_shipped'),
                ToggleColumn::make('is_priority'),
            ])
            ->filters([
                SelectFilter::make('status'),
                TernaryFilter::make('is_shipped'),
                TrashedFilter::make('trashed'),
            ])
            ->actions([
                ViewAction::make('view'),
                EditAction::make('edit'),
                DeleteAction::make('delete'),
            ])
            ->bulkActions([
                DeleteBulkAction::make('delete'),
            ]);
    }

    public static function infolist(Infolist $infolist): Infolist
    {
        return $infolist->schema([
            TextEntry::make('order_number'),
            TextEntry::make('customer.name'),
            IconEntry::make('is_shipped'),
        ]);
    }

    public static function getPages(): array
    {
        return [
            'index' => Pages\ListOrders::route('/'),
            'create' => Pages\CreateOrder::route('/create'),
            'view' => Pages\ViewOrder::route('/{record}'),
            'edit' => Pages\EditOrder::route('/{record}/edit'),
        ];
    }
}
