<?php

namespace App\Nova;

use App\Models\User as UserModel;
use App\Nova\Actions\SendWelcomeEmail;
use App\Nova\Actions\DeactivateUser;
use App\Nova\Filters\ActiveUsers;
use App\Nova\Lenses\MostValuableUsers;
use App\Nova\Metrics\NewUsers;
use Laravel\Nova\Fields\ID;
use Laravel\Nova\Fields\Text;
use Laravel\Nova\Fields\BelongsTo;
use Laravel\Nova\Fields\HasMany;
use Laravel\Nova\Resource;
use Laravel\Nova\Http\Requests\NovaRequest;

class User extends Resource
{
    public static $model = \App\Models\User::class;

    public static $title = 'name';

    public function fields(NovaRequest $request): array
    {
        return [
            ID::make()->sortable(),
            Text::make('Name'),
            Text::make('Email'),
            BelongsTo::make('Role', 'role', \App\Nova\Role::class),
            HasMany::make('Posts', 'posts', \App\Nova\Post::class),
        ];
    }

    public function actions(NovaRequest $request): array
    {
        return [
            new SendWelcomeEmail,
            new DeactivateUser,
        ];
    }

    public function filters(NovaRequest $request): array
    {
        return [
            new ActiveUsers,
        ];
    }

    public function lenses(NovaRequest $request): array
    {
        return [
            new MostValuableUsers,
        ];
    }

    public function cards(NovaRequest $request): array
    {
        return [
            new NewUsers,
        ];
    }
}
