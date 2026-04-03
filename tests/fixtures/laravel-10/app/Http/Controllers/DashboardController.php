<?php

namespace App\Http\Controllers;

use Laravel\Pennant\Feature;
use Illuminate\Http\Request;

class DashboardController extends Controller
{
    public function index(Request $request)
    {
        if (Feature::active('new-dashboard')) {
            return view('dashboard.new');
        }

        return view('dashboard.legacy');
    }

    public function checkout(Request $request)
    {
        Feature::when('beta-checkout',
            fn () => $this->newCheckout($request),
            fn () => $this->legacyCheckout($request)
        );
    }

    public function preferences()
    {
        $theme = Feature::value('dark-mode');

        return view('preferences', compact('theme'));
    }

    public function userDashboard(Request $request)
    {
        if (Feature::for($request->user())->active('new-dashboard')) {
            return view('dashboard.new');
        }

        return view('dashboard.old');
    }
}
