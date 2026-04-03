<?php

namespace App\Http\Controllers;

use App\Models\User;

class UserController extends Controller
{
    public function profile()
    {
        return auth()->user();
    }

    public function update()
    {
        return auth()->user()->update(request()->all());
    }
}
