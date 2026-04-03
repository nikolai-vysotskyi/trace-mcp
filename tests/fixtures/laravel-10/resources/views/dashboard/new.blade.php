@feature('new-dashboard')
    <div class="new-dashboard">
        <h1>New Dashboard</h1>
        @feature('beta-checkout')
            <a href="/checkout/beta">Try Beta Checkout</a>
        @endfeature
    </div>
@endfeature

@feature('dark-mode')
    <style>body { background: #333; color: #fff; }</style>
@endfeature
