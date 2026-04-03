<?php

namespace App\Nova\Metrics;

use App\Models\User;
use Laravel\Nova\Http\Requests\NovaRequest;
use Laravel\Nova\Metrics\Value;
use Laravel\Nova\Metrics\ValueResult;

class NewUsers extends Value
{
    public function calculate(NovaRequest $request): ValueResult
    {
        return $this->count($request, User::class);
    }
}
