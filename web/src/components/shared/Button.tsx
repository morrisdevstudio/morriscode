import { ButtonHTMLAttributes, forwardRef } from 'react'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger'
  size?: 'sm' | 'md' | 'lg'
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'secondary', size = 'md', className = '', children, ...props }, ref) => {
    const baseClasses = 'rounded-md font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed'

    const variantClasses = {
      primary: 'bg-text-primary text-bg-primary hover:opacity-90',
      secondary: 'border border-border bg-bg-tertiary text-text-primary hover:bg-border',
      danger: 'bg-accent-error text-white hover:opacity-90',
    }

    const sizeClasses = {
      sm: 'px-1.5 py-1 text-xs',
      md: 'px-3 py-1.5 text-sm',
      lg: 'px-4 py-2 text-base',
    }

    return (
      <button
        ref={ref}
        className={`${baseClasses} ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
        {...props}
      >
        {children}
      </button>
    )
  },
)

Button.displayName = 'Button'
